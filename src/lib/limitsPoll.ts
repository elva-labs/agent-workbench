import { core, type AgentId } from "$lib/core";
import { dirFor } from "$lib/accounts.svelte";
import { AGENTS } from "$lib/agent.svelte";
import { heardLimits } from "$lib/limits.svelte";
import { hostOf } from "$lib/remote.svelte";
import { byKey, isLive, sessions, type Session } from "$lib/sessions.svelte";

/**
 * Keeps the usage figures of the accounts in use fresh.
 *
 * An account is in use while a session of it runs here, or while one of its
 * sessions is on screen. Its figures are asked of the core of the machine
 * the session's project is on, which reads them only when its own schedule
 * says a read is due: when the newest is five minutes old, never twice at
 * once, and later after a read that failed. So the window asks often and
 * cheaply, and the core decides.
 *
 * The first time an account is asked for in this window, the figures the
 * machine kept are taken first, so they show with their age at once; then
 * the machine is asked to read. After that the accounts in use are asked
 * for every minute while the window is in use, and a session's account at
 * once when the session comes on screen. Only one question for an account
 * is out at a time.
 *
 * The window is in use while it is shown and the user has pressed a key,
 * pressed or moved the pointer, scrolled or brought the window forward in
 * the last ten minutes. Focus alone is not use: a window left in front of
 * an unattended machine asks for nothing, and the first act after asks at
 * once. A question that fails says nothing; the next minute asks again.
 */

/** How often the accounts in use are asked for while the window is in use. */
export const ASK_EVERY = 60_000;
/** How long after the user last acted the window stops being in use. */
export const IDLE_AFTER = 10 * 60_000;

/** An account in use: the machine, the agent and the account's name, with
    a project on that machine for the question to go to. */
export interface InUse {
  host: string | null;
  project: string;
  agent: AgentId;
  account: string | null;
}

function keyOf(use: InUse): string {
  return JSON.stringify([use.host, use.agent, use.account]);
}

function useOf(session: Session): InUse | null {
  if (!AGENTS.includes(session.agent)) return null;
  return {
    host: hostOf(session.project),
    project: session.project,
    agent: session.agent,
    account: session.account,
  };
}

/** Each account once: those of the sessions that run, and of the one on
    screen. */
export function accountsInUse(): InUse[] {
  const found = new Map<string, InUse>();
  for (const session of sessions.all) {
    if (!isLive(session) && session.key !== sessions.active) continue;
    const use = useOf(session);
    if (use !== null && !found.has(keyOf(use))) found.set(keyOf(use), use);
  }
  return [...found.values()];
}

/** The questions out, by account. */
const asking = new Map<string, Promise<void>>();
/** The accounts whose kept figures were taken in this window. */
const seen = new Set<string>();

async function take(use: InUse, read: boolean): Promise<void> {
  try {
    const report = await core().accountLimits({
      project: use.project,
      agent: use.agent,
      configDir: dirFor(use.account, use.agent),
      read,
    });
    if (report !== null && report !== undefined) heardLimits(use.host, use.account, report);
  } catch {
    // Quiet: the figures stay as they were, and the next minute asks again.
  }
}

/** Asks for an account's figures, unless a question for it is out. Resolves
    once the answer is taken. */
export function askFor(use: InUse): Promise<void> {
  const key = keyOf(use);
  const out = asking.get(key);
  if (out !== undefined) return out;
  const first = !seen.has(key);
  seen.add(key);
  const asked = (async () => {
    if (first) await take(use, false);
    await take(use, true);
  })().finally(() => asking.delete(key));
  asking.set(key, asked);
  return asked;
}

/** Asks for the figures of every account in use. */
export function askAll(): Promise<void> {
  return Promise.all(accountsInUse().map(askFor)).then(() => {});
}

/** Asks for the account of the session with this key, as it comes on
    screen. */
export function askForSession(key: string): Promise<void> {
  const session = byKey(key);
  const use = session === null ? null : useOf(session);
  return use === null ? Promise.resolve() : askFor(use);
}

let lastUsed = 0;

/** Whether the window is in use at `now`. */
export function inUse(now = Date.now()): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  return now - lastUsed < IDLE_AFTER;
}

/** The user acted: the window is in use, and after a long while not, every
    account in use is asked for at once. */
export function used(now = Date.now()) {
  const back = !inUse(now);
  lastUsed = now;
  if (back) void askAll();
}

const ACTS = ["keydown", "pointerdown", "pointermove", "wheel", "focus"] as const;

/** Keeps the figures of the accounts in use fresh while the window is in
    use, asking for them at once. Returns a stop function. */
export function followLimits(target: Window = window): () => void {
  const act = () => used();
  for (const name of ACTS) target.addEventListener(name, act, { capture: true, passive: true });
  const shown = () => {
    if (target.document.visibilityState === "visible") used();
  };
  target.document.addEventListener("visibilitychange", shown);
  lastUsed = Date.now();
  void askAll();
  const timer = setInterval(() => {
    if (inUse()) void askAll();
  }, ASK_EVERY);
  return () => {
    clearInterval(timer);
    for (const name of ACTS) target.removeEventListener(name, act, { capture: true });
    target.document.removeEventListener("visibilitychange", shown);
  };
}

/** Test seam. */
export function resetLimitsPoll() {
  asking.clear();
  seen.clear();
  lastUsed = 0;
}
