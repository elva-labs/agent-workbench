import { dirFor } from "$lib/accounts.svelte";
import { spoken } from "$lib/instructions";
import { sentBy, starterOf } from "$lib/senders.svelte";
import { agentProfile } from "$lib/agent.svelte";
import {
  core,
  isUntrusted,
  type IntegratedEvent,
  type IntegratedEventBody,
  type IntegratedImage,
  type IntegratedState,
  type PermissionChoice,
} from "$lib/core";
import { Conversation, type Part } from "$lib/conversation.svelte";
import {
  adopt,
  byKey,
  failed,
  loadHistory,
  named,
  noted,
  onIntegratedClose,
  rang,
  type Session,
} from "$lib/sessions.svelte";

/**
 * The integrated sessions behind their rows.
 *
 * An integrated session is a row like any other in the sessions store; this
 * is what runs behind it in place of a pty. Starting one asks the core to
 * start the agent, and every event the core sends for it goes to the row's
 * conversation and to the row itself: its state, working, asking or idle,
 * comes from those events alone, and its id is the conversation's id as the
 * agent said it when ready, so the agent's own tools find the row.
 *
 * The core names a session by an id of its own, which its first events can
 * carry before the start that hands it back has answered. Those events are
 * kept until the id is known and played then. A window that comes to a
 * session late, after a reload, keeps the events it hears while it asks for
 * the session's snapshot, plays them, and lays the snapshot over them.
 */

/** What runs behind one row. */
export class Link {
  /** The core's id for the session, while it runs. */
  handle = $state<string | null>(null);
  conversation: Conversation;
  /** The start was refused because the folder is not trusted yet. */
  untrusted = $state(false);
  /** A start, a trust or an attach is on its way. */
  busy = $state(false);
  /** What the user is writing, kept while another session is on screen. */
  draft = $state("");
  /** The images going with it. */
  images = $state<IntegratedImage[]>([]);
  /** Why the model could not be changed, until it next is. */
  configureError = $state<string | null>(null);
  /** Events heard while a snapshot is on its way. */
  held: IntegratedEventBody[] | null = null;
  /** An attach on its way, for a start to wait on. */
  attaching: Promise<boolean> | null = null;
  /** The first prompt was sent, for a session started with one. */
  prompted = false;

  constructor(clock: () => number) {
    this.conversation = new Conversation(clock);
  }
}

const links = new Map<string, Link>();
/** The row each running session belongs to, by the core's id. */
const byHandle = new Map<string, string>();
/** Events of ids no row has claimed yet, by the core's id, with when the
    first came. */
const early = new Map<string, { at: number; events: IntegratedEventBody[] }>();
/** Ids this window stopped, whose last events are let go. */
const stopped = new Set<string>();

/** How long unclaimed events are kept, and how many for one id. */
const EARLY_FOR = 120_000;
const EARLY_MOST = 5000;

let clock: () => number = Date.now;

/** The row's link, made the first time it is asked for. */
export function linkFor(key: string): Link {
  let link = links.get(key);
  if (link === undefined) {
    link = new Link(clock);
    links.set(key, link);
  }
  return link;
}

/** The conversation behind a row. */
export function conversationOf(key: string): Conversation {
  return linkFor(key).conversation;
}

/** The core's id for a row's session, while it runs. */
export function handleOf(key: string): string | null {
  return links.get(key)?.handle ?? null;
}

/** Listens to every integrated session's events for as long as the window
    is open. Answers with what stops listening. */
export async function listenIntegrated(): Promise<() => void> {
  try {
    return await core().onIntegratedEvent(heard);
  } catch {
    return () => {};
  }
}

/** One event from the core, for whichever row it belongs to. */
export function heard(event: IntegratedEvent) {
  const { id, ...body } = event;
  if (stopped.has(id)) {
    if (body.type === "ended") stopped.delete(id);
    return;
  }
  const key = byHandle.get(id);
  const link = key === undefined ? undefined : links.get(key);
  if (key === undefined || link === undefined) {
    keep(id, body as IntegratedEventBody);
    return;
  }
  if (link.held !== null) {
    link.held.push(body as IntegratedEventBody);
    return;
  }
  deliver(key, link, body as IntegratedEventBody);
}

function keep(id: string, body: IntegratedEventBody) {
  const now = Date.now();
  for (const [other, kept] of early)
    if (now - kept.at > EARLY_FOR) early.delete(other);
  let kept = early.get(id);
  if (kept === undefined) {
    kept = { at: now, events: [] };
    early.set(id, kept);
  }
  if (kept.events.length < EARLY_MOST) kept.events.push(body);
}

function claim(id: string): IntegratedEventBody[] {
  const kept = early.get(id)?.events ?? [];
  early.delete(id);
  return kept;
}

function deliver(key: string, link: Link, body: IntegratedEventBody) {
  const before = link.conversation.state;
  link.conversation.apply(body);
  const session = byKey(key);
  if (session === null) return;
  switch (body.type) {
    case "ready":
      identify(session, body.sessionId);
      break;
    case "configured":
      session.model = body.model;
      break;
    case "state":
      settle(session, body.state, before, link);
      break;
    case "ended":
      ended(session, link, body.code, body.clean);
      break;
  }
}

/** The conversation's id is the row's: what resuming takes, and what the
    agent's own tools name the session by. */
function identify(session: Session, id: string) {
  if (session.id === id) return;
  session.id = id;
  adopt(session.project, id);
}

/** The row says what the session's events say it is doing. A session that
    stops working or asking while nobody looks is unread, with the first
    line of what the agent last said unless it left a line of its own. */
function settle(
  session: Session,
  state: IntegratedState,
  before: IntegratedState | null,
  link: Link,
) {
  const working = state === "working";
  const asking = state === "asking";
  const changed = session.working !== working || (session.needs === "permission") !== asking;
  session.working = working;
  session.needs = asking ? "permission" : null;
  if (changed) session.changedAt = Date.now();
  if (asking && before !== "asking") rang(session.key);
  else if (state === "idle" && before !== null && before !== "idle") {
    const line = lastWords(link.conversation.entries);
    if (session.note === null && line !== null) noted(session.key, line);
    else rang(session.key);
  }
}

/** The first line of the last thing the agent said in the main thread. */
export function lastWords(entries: Conversation["entries"]): string | null {
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at];
    if (entry.kind !== "agent") continue;
    const text = lastText(entry.parts);
    if (text !== null) return text;
  }
  return null;
}

function lastText(parts: Part[]): string | null {
  for (let at = parts.length - 1; at >= 0; at--) {
    const part = parts[at];
    if (part.kind !== "text") continue;
    const line = part.text
      .split("\n")
      .map((candidate) =>
        candidate
          .replace(/^[#>*\-\s]+/, "")
          .replace(/\*\*|__|`/g, "")
          .trim(),
      )
      .find((candidate) => candidate !== "");
    if (line !== undefined) return line;
  }
  return null;
}

function ended(session: Session, link: Link, code: number | null, clean: boolean) {
  if (link.handle !== null) byHandle.delete(link.handle);
  link.handle = null;
  session.status = clean && !link.conversation.notLoggedIn ? "exited" : "crashed";
  session.exitCode = code;
  session.working = false;
  session.needs = null;
  session.changedAt = Date.now();
  rang(session.key);
  // The transcript is complete now, so the history it belongs in moved.
  void loadHistory(session.project);
}

/**
 * Starts the agent behind a row whose status is starting: a new session,
 * or the one the row resumes. In a folder the agent does not trust yet the
 * start is refused, and the row waits for the user's answer.
 */
export async function launch(key: string): Promise<void> {
  const session = byKey(key);
  if (session === null || session.kind !== "integrated") return;
  const link = linkFor(key);
  if (link.attaching !== null && (await link.attaching)) return;
  if (link.handle !== null || link.busy) return;
  link.busy = true;
  link.untrusted = false;
  try {
    const started = await core().integratedStart({
      agent: session.agent,
      project: session.project,
      cwd: session.startIn ?? undefined,
      session: session.resumedFrom ?? undefined,
      model: session.model ?? undefined,
      mode: startMode(session, link),
      configDir: dirFor(session.account, session.agent),
    });
    link.busy = false;
    const row = byKey(key);
    if (row === null) {
      // The row was closed while the agent came up: nothing owns it now.
      stopped.add(started.id);
      claim(started.id);
      core()
        .integratedStop(started.id)
        .catch(() => {});
      return;
    }
    link.handle = started.id;
    byHandle.set(started.id, key);
    row.status = "running";
    row.error = null;
    row.exitCode = null;
    row.changedAt = Date.now();
    for (const body of claim(started.id)) deliver(key, link, body);
    if (started.sessionId !== null) identify(row, started.sessionId);
    if (row.prompt !== null && !link.prompted && link.handle !== null) {
      link.prompted = true;
      send(key, row.prompt, [], starterOf(key));
    }
  } catch (error) {
    link.busy = false;
    if (byKey(key) === null) return;
    if (isUntrusted(error)) {
      link.untrusted = true;
      failed(key, "The folder is not trusted yet.");
    } else failed(key, message(error));
  }
}

/** The mode a session starts in: the one it ran in, when the user chose
    one the agent offers, and otherwise the agent's safe one, which asks
    before it acts. The agent's own configuration never decides it. */
export function startMode(session: Session, link: Link): string {
  const mode = link.conversation.settings.mode;
  const offered = link.conversation.ready?.modes.some((known) => known.value === mode) ?? false;
  return mode !== null && offered ? mode : agentProfile(session.agent).safeMode;
}

/** The user trusts the folder: recorded where the agent's own question
    would have recorded it, and the session starts. */
export async function trust(key: string): Promise<void> {
  const session = byKey(key);
  if (session === null || session.kind !== "integrated") return;
  const link = linkFor(key);
  if (link.busy) return;
  link.busy = true;
  try {
    await core().integratedTrust({
      agent: session.agent,
      project: session.project,
      cwd: session.startIn ?? undefined,
      configDir: dirFor(session.account, session.agent),
    });
  } catch (error) {
    link.busy = false;
    failed(key, message(error));
    return;
  }
  link.busy = false;
  link.untrusted = false;
  again(session);
  await launch(key);
}

/** Starts a row that ended or failed again, resuming its conversation when
    it has one. What the window drew of it stays, and goes on. */
export async function resume(key: string): Promise<void> {
  const session = byKey(key);
  if (session === null || session.kind !== "integrated") return;
  const link = linkFor(key);
  if (link.handle !== null || link.busy) return;
  if (session.id !== null) session.resumedFrom = session.id;
  link.conversation.resumed();
  again(session);
  await launch(key);
}

function again(session: Session) {
  session.status = "starting";
  session.error = null;
  session.exitCode = null;
  session.changedAt = Date.now();
}

/**
 * Takes up a session the core may still be running from before the window
 * was reloaded. The snapshot says what no event will say again; the events
 * heard while it was asked for come before it. True when the session was
 * there and is the row's.
 */
export function reattach(key: string, handle: string): Promise<boolean> {
  const link = linkFor(key);
  const attempt = (async () => {
    if (link.handle !== null) return true;
    link.busy = true;
    byHandle.set(handle, key);
    link.held = claim(handle);
    try {
      const snapshot = await core().integratedSnapshot(handle);
      const session = byKey(key);
      if (
        session === null ||
        (snapshot.ready !== null && session.id !== null && snapshot.ready.sessionId !== session.id)
      )
        throw new Error("another session");
      const held = link.held ?? [];
      link.held = null;
      link.handle = handle;
      session.status = "running";
      for (const body of held) deliver(key, link, body);
      const before = link.conversation.state;
      link.conversation.restore(snapshot);
      if (snapshot.ready !== null) identify(session, snapshot.ready.sessionId);
      settle(session, snapshot.state, before, link);
      return true;
    } catch {
      link.held = null;
      if (byHandle.get(handle) === key) byHandle.delete(handle);
      return false;
    } finally {
      link.busy = false;
    }
  })();
  link.attaching = attempt;
  void attempt.finally(() => {
    if (link.attaching === attempt) link.attaching = null;
  });
  return attempt;
}

/** Sends the user's message under an id of the window's own. A row with no
    name yet takes the first line of its first message. */
/** Sends a message to the agent: the user's, or with `from` another
    session's, which the thread then shows under that session's name. */
export function send(
  key: string,
  text: string,
  images: IntegratedImage[] = [],
  from: string | null = null,
): string | null {
  const link = links.get(key);
  const session = byKey(key);
  if (link === undefined || link.handle === null || session === null) return null;
  if (text.trim() === "" && images.length === 0) return null;
  const id = crypto.randomUUID();
  link.conversation.sending(id, text, images);
  // A message sent is the agent spoken to, by the user or by a session
  // that started it.
  session.engaged = true;
  session.note = null;
  if (from !== null) sentBy(id, from);
  // Named by its first line, without the workbench's sentence after a
  // started session's prompt.
  if (session.title === null) {
    const line = spoken(text).text.split("\n").find((candidate) => candidate.trim() !== "")?.trim();
    if (line !== undefined) named(key, line.length > 60 ? `${line.slice(0, 59)}…` : line);
  }
  core()
    .integratedSend(link.handle, id, text, images)
    .catch((error) => link.conversation.sendFailed(id, message(error)));
  return id;
}

/** Stops the running turn. Messages that wait go on waiting. */
export function interrupt(key: string) {
  const link = links.get(key);
  if (link === undefined || link.handle === null) return;
  if (link.conversation.current === null && !link.conversation.working) return;
  // Only a turn has an end to wait for; with none running the interrupt
  // stops waiting on what was left at work, and nothing is stopping.
  if (link.conversation.current !== null) link.conversation.interrupting = true;
  core()
    .integratedInterrupt(link.handle)
    .catch(() => (link.conversation.interrupting = false));
}

/** Answers a permission request with one of the choices it offered. */
export function answer(key: string, request: string, choice: PermissionChoice, words?: string) {
  const link = links.get(key);
  if (link === undefined || link.handle === null) return;
  link.conversation.answering(request, true);
  core()
    .integratedAnswer(link.handle, request, choice, words?.trim() ? words.trim() : undefined)
    .catch((error) => link.conversation.answering(request, false, message(error)));
}

/** Answers a question: per question, the options picked or the user's own
    words; null declines to answer. */
export function reply(key: string, request: string, answers: string[][] | null) {
  const link = links.get(key);
  if (link === undefined || link.handle === null) return;
  link.conversation.answering(request, true);
  core()
    .integratedReply(link.handle, request, answers)
    .catch((error) => link.conversation.answering(request, false, message(error)));
}

/** Switches the model the session runs on. */
export async function configure(key: string, change: { model?: string; mode?: string; effort?: string }) {
  const link = links.get(key);
  if (link === undefined || link.handle === null) return;
  link.configureError = null;
  try {
    const settings = await core().integratedConfigure(link.handle, change);
    link.conversation.settings = settings;
  } catch (error) {
    link.configureError = message(error);
  }
}

/** The row is closed: its agent is stopped, and its last words let go. */
function stop(session: Session) {
  const link = links.get(session.key);
  links.delete(session.key);
  if (link?.handle === null || link === undefined) return;
  const handle = link.handle;
  byHandle.delete(handle);
  stopped.add(handle);
  core()
    .integratedStop(handle)
    .catch(() => stopped.delete(handle));
}

onIntegratedClose(stop);

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error:\s*/, "");
}

/** Test seam. */
export function resetIntegrated(time: () => number = Date.now) {
  links.clear();
  byHandle.clear();
  early.clear();
  stopped.clear();
  clock = time;
}
