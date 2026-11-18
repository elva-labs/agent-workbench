import { tick } from "svelte";
import { dirFor } from "$lib/accounts.svelte";
import { spoken } from "$lib/instructions";
import { unsent, type Sent } from "$lib/mention";
import { mentionedIn, mentionsOf } from "$lib/mentioned.svelte";
import { reservedName, shown } from "$lib/unseen";
import { failureOf } from "$lib/turnFailure";
import { senderOf, sentAt, sentBy, starterOf, WORKBENCH } from "$lib/senders.svelte";
import { keepMode, modeOf } from "$lib/sessionModes";
import { nextNarrower } from "$lib/modeFit";
import { heardLimits } from "$lib/limits.svelte";
import { hostOf } from "$lib/remote.svelte";
import {
  core,
  isUntrusted,
  type IntegratedEvent,
  type IntegratedEventBody,
  type IntegratedImage,
  type IntegratedState,
  type PermissionChoice,
} from "$lib/core";
import { Conversation, type Message, type Part } from "$lib/conversation.svelte";
import { earlierAtStart, layEarlier, runFrom } from "$lib/earlier";
import { clock as timeOfDay } from "$lib/thread";
import {
  nameTaken,
  adopt,
  beganTurn,
  byKey,
  failed,
  followsAgain,
  givenName,
  keepToken,
  renewToken,
  loadHistory,
  named,
  newTurnLine,
  lineComing,
  userWrote,
  leaveRun,
  movingBySetting,
  noted,
  onIntegratedClose,
  onIntegratedHalt,
  onSaid,
  putUnder,
  rang,
  rejoined,
  rememberWorkflow,
  reopeningRow,
  runEnded,
  runUp,
  toldAtStart,
  toldFor,
  type Session,
  type Told,
} from "$lib/sessions.svelte";
import { orchestratorPrompt, startsOnly } from "$lib/workflowInstructions";
import { workflowNamed } from "$lib/workflows.svelte";
import type { AgentId } from "$lib/core";

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
 * the session's snapshot, plays them, and lays the snapshot over them. The
 * account's limits go to the store that keeps them by account.
 */

/** A file going with a message that is not an image: it goes as its path,
    for the agent to read. */
export interface Attached {
  /** As the agent is told of it: from where it works when inside that,
      else in full. */
  path: string;
  name: string;
  size: number | null;
  dir: boolean;
  /** The folder it is in, when that is outside the project. */
  from: string | null;
}

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
  /** The paths of the files mentioned in it, as picked from the menu. */
  mentions = $state<string[]>([]);
  /** The files that are not images going with it, by path. */
  files = $state<Attached[]>([]);
  /** Why the model could not be changed, until it next is. */
  configureError = $state<string | null>(null);
  /** Why the conversation could not be compacted, until it next is. */
  compactError = $state<string | null>(null);
  /** The waiting messages were asked to go now, and the core has not
      answered yet. */
  sendingNow = $state(false);
  /** The messages sent now that are still on their way into a turn: each
      until the agent takes it, drops it, or says it waits again. */
  sentNow = $state<string[]>([]);
  /** What is being sent goes now with the messages that wait, once the
      agent says it waits too. */
  nowOnQueue = false;
  /** The messages this window asked to take back, kept whole until the
      agent lets go of each, when they go back to the composer. */
  takingBack = new Map<string, Message>();
  /** The messages Up took back, oldest first, with the words, mentions
      and images of each the agent has let go of, the place among the
      messages sent the oldest of them had, and the composer's words as Up
      last left them: while they stand there unchanged, Up takes the one
      before, and each comes back in the order sent. */
  upChain = $state<{
    ids: string[];
    back: Record<string, { draft: string; mentions: string[]; images: IntegratedImage[] }>;
    from: number;
    draft: string;
  } | null>(null);
  /** Why the waiting messages could not be sent now, or a message taken
      back, until the waiting messages or the turn next change. */
  nowError = $state<string | null>(null);
  /** A compaction was asked for while a turn ran, and waits for it to
      end. */
  compactAsked = $state(false);
  /** The agent has said or done something of its own since it last came
      to rest: answered a message, written, thought, called a tool, asked,
      or failed. A spell of work that was only a compaction leaves it
      false. A turn already running when the window took the session up
      sets it, what came before being unknown. */
  worked = false;
  /** Events heard while a snapshot is on its way. */
  held: IntegratedEventBody[] | null = null;
  /** An attach on its way, for a start to wait on. */
  attaching: Promise<boolean> | null = null;
  /** The first prompt was sent, for a session started with one. */
  prompted = false;
  /** The run behind the row is being started again under the workflow
      just picked. The session counts as ready meanwhile: a message sent
      waits for the new run, and a change of model or mode is made on it. */
  restarting = $state(false);
  /** A change of model, mode or effort to make on the run starting again
      once it is up. */
  after: Change | null = null;
  /** The changes asked of the run behind the row and not answered yet. */
  unanswered = new Set<Change>();
  /** The user chose the mode the session runs in. */
  modeChosen = false;
  /** What the run behind the row was started on. */
  ranOn: Run | null = null;
  /** The agent the row was started on, once a workflow picked for it may
      have put it on another: no workflow puts it back. */
  startedOn = $state<AgentId | null>(null);
  /** Going back is on its way: the message gone back to, as it stood,
      how it goes back, and the messages the thread let go of for it, until
      the core has answered. */
  goingBack = $state<{ message: Message; way: BackWay; gone: string[] } | null>(null);
  /** Counts the times going back did not go back, so a send held for it
      goes only where it did. */
  backMissed = $state(0);
  /** What the composer says of the last going back, until the next message
      is sent: the files put back, or why it did not go back. */
  backSaid = $state<string | null>(null);
  /** The composer's words as going back left them, and as they were
      before, so undoing it, or its failing, puts back what was there where
      they stand unchanged. */
  backDraft: { after: string; before: Pick<Link, "draft" | "images" | "mentions" | "files"> } | null = null;
  /** What the user allowed for the rest of this run alone, in the words
      the offer said it keeps: what the run ends with it. A permission mode
      allowed so is not here, since the conversation's mode goes on into
      its next run. */
  granted = $state<string[]>([]);

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

/** The row's link, when one was made for it; never makes one. */
export function linkOf(key: string): Link | null {
  return links.get(key) ?? null;
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

/** Whether an event is the agent's own doing rather than its keeping house.
    Housekeeping is a compaction and what a run reports of itself: its
    state, settings, limits, context and notices, a retry, a turn's start
    and end, and the user's messages. A turn that answers a message is the
    agent's doing, and so is everything else, an event of a kind not named
    here included. */
function isWork(body: IntegratedEventBody): boolean {
  switch (body.type) {
    case "turnStarted":
      return body.messages.length > 0;
    case "compacting":
    case "compacted":
    case "compactFailed":
    case "state":
    case "ready":
    case "configured":
    case "commands":
    case "limits":
    case "context":
    case "notice":
    case "retrying":
    case "skipped":
    case "turnEnded":
    case "message":
    case "answered":
    case "withdrawn":
    case "ended":
      return false;
    default:
      return true;
  }
}

function deliver(key: string, link: Link, body: IntegratedEventBody) {
  if (body.type === "rewound") {
    wentBack(link, body);
    return;
  }
  const before = link.conversation.state;
  // A message this window asked to take back goes back to its composer the
  // moment the agent lets go of it, whatever the answer to the asking.
  const back =
    body.type === "message" && body.state === "withdrawn" ? link.takingBack.get(body.message) : undefined;
  if (back !== undefined) link.takingBack.delete(back.id);
  const granting = body.type === "answered" && body.choice === "allowSession" ? grantOf(link, body.request) : null;
  link.conversation.apply(body);
  if (granting !== null) link.granted = [...link.granted, granting];
  if (back !== undefined) restore(key, back);
  // What failed to go now, or to come back, is old news once the waiting
  // messages or the turn move on.
  if (body.type === "message" || body.type === "turnStarted" || body.type === "turnEnded") link.nowError = null;
  if (body.type === "message" && body.state !== "sent" && link.sentNow.includes(body.message))
    link.sentNow = link.sentNow.filter((id) => id !== body.message);
  if (body.type === "turnStarted" && link.sentNow.length > 0)
    link.sentNow = link.sentNow.filter((id) => !body.messages.includes(id));
  // A message sent to go now: once it waits, everything waiting goes; one
  // the agent took at once has nothing to wait for.
  if (body.type === "turnEnded") link.nowOnQueue = false;
  if (link.nowOnQueue && body.type === "message" && body.text !== null && senderOf({ id: body.message }) === null) {
    link.nowOnQueue = false;
    if (body.state === "queued") void sendNow(key);
  }
  if (isWork(body)) link.worked = true;
  if (
    body.type === "compacting" ||
    body.type === "compacted" ||
    body.type === "compactFailed" ||
    body.type === "turnEnded" ||
    body.type === "ended"
  )
    link.compactAsked = false;
  if (body.type === "message" || body.type === "turnStarted" || body.type === "ended")
    settleNotes(key, link);
  const session = byKey(key);
  if (session === null) return;
  switch (body.type) {
    case "ready":
      identify(session, body.sessionId);
      // This run started on the workflow the row follows now.
      rememberWorkflow(session);
      keepRunMode(session, link);
      if (session.modeGiven !== null && session.modeNamed === session.modeGiven && body.mode !== session.modeGiven)
        void fallBack(key, link, session.agent, session.modeGiven, body.mode);
      break;
    case "configured":
      session.model = body.model;
      keepRunMode(session, link);
      break;
    case "limits":
      heardLimits(hostOf(session.project), session.account, body);
      break;
    case "state":
      settle(session, body.state, before, link);
      break;
    case "turnStarted":
      session.turnEnd = null;
      beganTurn(session);
      break;
    case "turnEnded":
      // Interrupted is the user's stop; a turn that failed ended on an
      // error, a usage limit among them, which is said for what it is.
      session.turnEnd = body.outcome === "done" ? "done" : body.outcome === "interrupted" ? "cut" : "failed";
      session.failure = body.outcome === "failed" ? failureOf(null, body.error === null ? null : shown(body.error)) : null;
      break;
    case "ended":
      ended(session, link, body.code, body.clean);
      break;
  }
}

/** The words of what allowing a request for the session keeps, while the
    request is open: null for a request this run did not ask, and for a
    permission mode, which the conversation keeps into its next run. */
function grantOf(link: Link, id: string): string | null {
  const request = link.conversation.requests.find((known) => known.request === id);
  if (request === undefined || request.state !== "open" || request.asked.type !== "permissionAsked") return null;
  const kept = request.asked.choices.find((offer) => offer.choice === "allowSession")?.remembers ?? null;
  if (kept === null || !kept.endsWith(FOR_SESSION) || KEEPS_MODE.test(kept)) return null;
  return kept.slice(0, -FOR_SESSION.length);
}

/** How an offer says it keeps what it allows until the run ends. One that
    keeps it for the rest of a turn has let go of it by the time the
    session is at rest. */
const FOR_SESSION = " for the rest of this session";
/** How Claude Code's offer to switch the permission mode for the rest of
    the session says what it keeps. */
const KEEPS_MODE = /permission mode for the rest of this session$/;

/** The conversation's id is the row's: what resuming takes, and what the
    agent's own tools name the session by. */
function identify(session: Session, id: string) {
  if (session.id === id) return;
  session.id = id;
  keepToken(session);
  adopt(session.project, id);
}

/** The row says what the session's events say it is doing. A session that
    stops working or asking while nobody looks is unread, with the first
    line of what the agent last said unless it left a line of its own, when
    the agent did something of its own meanwhile: a compaction the agent
    does by itself while idle is housekeeping, and marks nothing. */
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
    const worked = link.worked;
    link.worked = false;
    if (!worked) return;
    const line = lastWords(link.conversation.entries);
    lineComing(session.key);
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
  // A run a reopen stopped goes on the other way, and its row never ends.
  if (runEnded(session.key)) return;
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
 * or the one the row resumes, told the workflow it follows as a terminal
 * session is. In a folder the agent does not trust yet the start is
 * refused, and the row waits for the user's answer.
 */
export async function launch(key: string): Promise<void> {
  const session = byKey(key);
  if (session === null || session.kind !== "integrated") return;
  const link = linkFor(key);
  if (link.attaching !== null && (await link.attaching)) return;
  if (link.handle !== null || link.busy) return;
  link.busy = true;
  link.untrusted = false;
  // What a resumed session said before goes above what this run says.
  earlierAtStart(session, link.conversation);
  try {
    // A resumed row finds out here what it follows, and a lost workflow
    // fails it with the question for the user.
    const told = await toldAtStart(key);
    const starting = byKey(key);
    if (told === null || starting === null) {
      link.busy = false;
      return;
    }
    await begin(key, link, starting, told);
  } catch (error) {
    startFailed(key, link, error);
  }
  settleRun(key);
}

/** Asks the core to start the agent behind a row, as the row is now and
    told what it is told, and takes the run up once it is. */
async function begin(key: string, link: Link, starting: Session, told: Told) {
  link.ranOn = { agent: starting.agent, told: toldText(told.instructions, told.startOnly) };
  link.granted = [];
  const mode = startMode(starting, link);
  starting.modeNamed = mode ?? null;
  const started = await core().integratedStart({
    agent: starting.agent,
    project: starting.project,
    cwd: starting.startIn ?? undefined,
    session: starting.resumedFrom ?? undefined,
    token: starting.token,
    model: starting.model ?? undefined,
    mode,
    configDir: dirFor(starting.account, starting.agent),
    ...told,
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
  if (row.status !== "running") {
    row.status = "running";
    // A row its agent's setting moved says nothing new.
    if (!movingBySetting(key)) row.changedAt = Date.now();
  }
  runUp(key);
  row.error = null;
  row.exitCode = null;
  for (const body of claim(started.id)) deliver(key, link, body);
  if (started.sessionId !== null) identify(row, started.sessionId);
  // Every start and resume keeps the copy of the workflow this run was
  // started on, which a reload goes on with; an agent that makes its own
  // id is kept once ready names it.
  rememberWorkflow(row);
  if (row.prompt !== null && !link.prompted && link.handle !== null) {
    link.prompted = true;
    send(key, row.prompt, [], starterOf(key));
  }
}

function startFailed(key: string, link: Link, error: unknown) {
  link.busy = false;
  if (byKey(key) === null) return;
  if (isUntrusted(error)) {
    link.untrusted = true;
    failed(key, "The folder is not trusted yet.");
  } else failed(key, message(error));
}

/** A change of the settings a run is on. */
type Change = { model?: string; mode?: string; effort?: string };

/** What a run is started on, to tell whether the run behind a row is the
    one the row says: the agent, and the workflow's instructions and
    whether they take the agent's own subagents away. */
interface Run {
  agent: AgentId;
  told: string | null;
}

function runOf(session: Session): Run {
  const workflow = session.workflow;
  return {
    agent: session.agent,
    told: workflow === null ? null : toldText(orchestratorPrompt(workflow), startsOnly(workflow)),
  };
}

function toldText(instructions: string | undefined, startOnly: boolean | undefined): string | null {
  return instructions === undefined ? null : `${startOnly === true}\n${instructions}`;
}

function sameRun(a: Run | null, b: Run): boolean {
  return a !== null && a.agent === b.agent && a.told === b.told;
}

/**
 * Whether a row is a new conversation nothing has been said in yet: one
 * the user started, not resumed and not started by another session, its
 * run starting or running, with no message sent and no turn run. Such a
 * row can still be put under another workflow.
 */
export function unspoken(session: Session): boolean {
  if (session.kind !== "integrated" || session.resumedFrom !== null || session.prompt !== null) return false;
  if (session.status !== "starting" && session.status !== "running") return false;
  if (starterOf(session.key) !== null) return false;
  const link = links.get(session.key);
  return link === undefined || (!link.untrusted && link.conversation.untouched);
}

/**
 * Puts a new conversation nothing has been said in under a workflow, or
 * under none, by its name: the row is the workflow's orchestrator from
 * now, as a session started under it is, and the run behind it starts
 * again under it, keeping the row and its token. The restart waits for a
 * start that is on its way, and never comes after a message: the run is
 * stopped before a message could be sent to it. The words being written
 * stay where they are, and a message sent meanwhile waits for the new run.
 */
export function follow(key: string, name: string | null) {
  const session = byKey(key);
  if (session === null || !unspoken(session) || (session.workflow?.name ?? null) === name) return;
  const workflow = name === null ? null : (workflowNamed(name) ?? null);
  if (name !== null && workflow === null) return;
  const link = linkFor(key);
  link.startedOn ??= session.agent;
  if (!putUnder(key, workflow, link.startedOn)) return;
  settleRun(key);
}

/** The agent a new conversation runs on under no workflow: the one it was
    started on. */
export function aloneOn(session: Session): AgentId {
  return links.get(session.key)?.startedOn ?? session.agent;
}

/** Starts the run behind a new conversation again when it is not the one
    its row now says: once no start is on its way, and only while nothing
    has been said in it. */
function settleRun(key: string) {
  const session = byKey(key);
  const link = links.get(key);
  if (session === null || link === undefined || link.busy || link.handle === null) return;
  if (!unspoken(session) || sameRun(link.ranOn, runOf(session))) return;
  void restart(key, session, link);
}

async function restart(key: string, session: Session, link: Link) {
  const handle = link.handle;
  if (handle === null) return;
  link.busy = true;
  link.restarting = true;
  const sameAgent = link.ranOn?.agent === session.agent;
  // The new run starts in the user's last choice of mode: one asked for
  // while a run started again, else one asked of the run being left and
  // not answered yet. A model or an effort asked of that run goes with
  // it, since the pick sets the model and an effort is the model's.
  const asked: Change = Object.assign({}, ...link.unanswered);
  link.unanswered.clear();
  const mode = link.after?.mode ?? asked.mode;
  // Stopped at once, so nothing is sent to the run being left, and what it
  // says from here is let go.
  link.handle = null;
  byHandle.delete(handle);
  stopped.add(handle);
  core()
    .integratedStop(handle)
    .catch(() => {});
  link.conversation.restarted(session.model, sameAgent);
  if (sameAgent && mode !== undefined) link.conversation.settings = { ...link.conversation.settings, mode };
  // What was asked while a run started again, other than the mode, is
  // made on the new run once it is up: a model only where no workflow
  // sets it.
  const { mode: _mode, model, ...rest } = link.after ?? {};
  const later: Change = { ...rest, ...(model === undefined || session.workflow !== null ? {} : { model }) };
  link.after = Object.keys(later).length === 0 ? null : later;
  leaveRun(session);
  try {
    await begin(key, link, session, toldFor(session));
  } catch (error) {
    startFailed(key, link, error);
    link.after = null;
    link.restarting = false;
    return;
  }
  // A pick made while this run came up starts it again at once, and what
  // was asked meanwhile waits for that run.
  const row = byKey(key);
  if (row !== null && link.handle !== null && unspoken(row) && !sameRun(link.ranOn, runOf(row))) {
    settleRun(key);
    return;
  }
  const change = link.after;
  link.after = null;
  if (change !== null && link.handle !== null) {
    // Made before a message waiting for the new run is sent.
    link.busy = true;
    await configure(key, change);
    link.busy = false;
  }
  link.restarting = false;
  settleRun(key);
}

/** The mode a session starts in: the one it last ran in, where the window
    knows it and the agent offers it, and for a new conversation another
    session started, the mode its starter gave it. Otherwise none is named,
    and the agent decides as it does in a terminal: by the mode a resumed
    conversation last ran in, where the agent keeps that, else by the
    user's own settings. A mode from those settings that the agent does
    not offer is left to them again rather than replaced. */
export function startMode(session: Session, link: Link): string | undefined {
  const given = session.resumedFrom === null ? (session.modeGiven ?? undefined) : undefined;
  const mode = link.conversation.settings.mode;
  if (mode !== null) {
    if (!offers(link, mode)) return given;
    // A new conversation nothing has been said in starts again as a new
    // one would, unless the user chose its mode.
    return unspoken(session) && !link.modeChosen ? given : mode;
  }
  if (session.resumedFrom !== null) return modeOf(session.resumedFrom) ?? undefined;
  // One reopened before anything was said in it starts in the mode kept
  // for the conversation it leaves.
  return given ?? (session.id === null ? undefined : (modeOf(session.id) ?? undefined));
}

/**
 * A session its starter gave a mode the agent did not take, as auto where
 * the account or the model has none, runs in the nearest narrower mode the
 * agent offers rather than the one the agent chose for itself, so it holds
 * no more than its starter and no less than it may.
 */
async function fallBack(key: string, link: Link, agent: AgentId, given: string, took: string | null) {
  let mode = nextNarrower(agent, given);
  while (mode !== null && !offers(link, mode)) mode = nextNarrower(agent, mode);
  if (mode === null || mode === took) return;
  await configure(key, { mode });
  if (link.conversation.settings.mode !== mode) return;
  const name = (value: string) => link.conversation.ready?.modes.find((known) => known.value === value)?.name ?? value;
  link.conversation.apply({
    type: "notice",
    level: "info",
    message: `The session that started it runs in ${name(given)} mode, so it runs in ${name(mode)} mode, the nearest below that it can take.`,
  });
}

/** Whether the agent behind the link offers a mode to switch to. */
function offers(link: Link, mode: string): boolean {
  return link.conversation.ready?.modes.some((known) => known.value === mode) ?? false;
}

/** Keeps the mode the conversation runs in now, for the next time it
    starts. */
function keepRunMode(session: Session, link: Link) {
  const mode = link.conversation.settings.mode;
  if (session.id !== null) keepMode(session.id, mode, mode !== null && offers(link, mode));
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
  if (session.id !== null) {
    session.resumedFrom = session.id;
    followsAgain(key);
  }
  link.conversation.resumed();
  again(session);
  await launch(key);
}

function again(session: Session) {
  renewToken(session);
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
export function reattach(key: string, handle: string, spoken = true): Promise<boolean> {
  const link = linkFor(key);
  const attempt = (async () => {
    if (link.handle !== null) return true;
    link.busy = true;
    byHandle.set(handle, key);
    link.held = claim(handle);
    try {
      const snapshotting = core().integratedSnapshot(handle);
      // What it said before goes above what is heard meanwhile.
      const row = byKey(key);
      const earlier =
        row !== null && link.conversation.earlier === null && link.conversation.entries.length === 0
          ? layEarlier(row, link.conversation, runFrom(snapshotting))
          : null;
      const snapshot = await snapshotting;
      const session = byKey(key);
      if (
        session === null ||
        (snapshot.ready !== null && session.id !== null && snapshot.ready.sessionId !== session.id) ||
        // A row named by its id takes up only a run that has said that id:
        // one that has not may be a newer session the core numbered the
        // same, and the row would be a running session named by an id no
        // process of it holds.
        (snapshot.ready === null && session.id !== null && session.token === session.id)
      )
        throw new Error("another session");
      await earlier;
      const held = link.held ?? [];
      link.held = null;
      link.handle = handle;
      session.status = "running";
      for (const body of held) deliver(key, link, body);
      const before = link.conversation.state;
      link.conversation.restore(snapshot);
      if (snapshot.turn || snapshot.state !== "idle") link.worked = true;
      if (snapshot.limits !== null) heardLimits(hostOf(session.project), session.account, snapshot.limits);
      // Only a session that was spoken to has earlier messages to point
      // at, where they could not be read.
      link.conversation.late = spoken && link.conversation.earlier !== "read";
      // The same session goes on, not one resumed from its transcript: it
      // keeps the name it had.
      session.resumedFrom = null;
      if (snapshot.ready !== null) identify(session, snapshot.ready.sessionId);
      settle(session, snapshot.state, before, link);
      void rejoined(key);
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

/** What goes ahead of the user's words in a message to a session, and
    what counts it as told once the agent takes the message, from the
    module that knows what the sessions it started have done: told by it.
    `untold` counts it as not told again, for a message the conversation
    went back on. */
export interface Note {
  text: string;
  deliver: () => void;
  untold?: () => void;
}

let noteFor: (key: string) => Note | null = () => null;

export function notesFrom(how: (key: string) => Note | null) {
  noteFor = how;
}

/** What follows a message the agent has not taken yet, by the message's
    id, with the row it went to: what happens once the agent takes it into
    a turn, and what happens when it never reaches the agent. */
const notes = new Map<string, { key: string; taken: () => void; lost: () => void; untold: () => void }>();

/** What counts the note a taken message carried as not told again, by the
    message's id, for a conversation that goes back on it. */
const toldBy = new Map<string, () => void>();

/** Settles what follows each message the agent has taken into a turn, or
    that never reaches it: it failed, was dropped, or the session went
    first. */
function settleNotes(key: string, link: Link | undefined) {
  for (const [id, held] of [...notes]) {
    if (held.key !== key) continue;
    const state = link?.conversation.messages[id]?.state;
    if (state === "taken") {
      notes.delete(id);
      held.taken();
      toldBy.set(id, held.untold);
    } else if (state === undefined || state === "dropped" || state === "failed") {
      notes.delete(id);
      held.lost();
    }
  }
}

/** Whether a message from the user to this session waits for its agent to
    take it. */
export function userWaiting(key: string): boolean {
  const conversation = links.get(key)?.conversation;
  if (conversation === undefined) return false;
  return Object.values(conversation.messages).some(
    (message) =>
      (message.state === "sending" || message.state === "queued" || message.state === "sent") &&
      senderOf(message) === null,
  );
}

/** Whether the user is writing to this session: words or images in its
    composer, or a message of theirs that waits for the agent. */
export function userWriting(key: string): boolean {
  const link = links.get(key);
  if (link === undefined) return false;
  return link.draft.trim() !== "" || link.images.length > 0 || userWaiting(key);
}

/** Sends the workbench's own message to an idle session, which the thread
    shows as the workbench's. `lost` runs when it never reaches the agent.
    Null when there is no agent to send it to. */
export function sendAsWorkbench(key: string, text: string, lost: () => void): string | null {
  const id = send(key, text, [], WORKBENCH);
  if (id !== null) notes.set(id, { key, taken: () => {}, lost, untold: lost });
  return id;
}

/** Sends the user's message under an id of the window's own. A row with no
    name yet takes the first line of its first message. */
/** Sends a message to the agent: the user's, or with `from` another
    session's, which the thread then shows under that session's name. The
    user's goes with the workbench's note on the sessions it started ahead
    of their words, when there is one. */
export function send(
  key: string,
  words: string,
  images: IntegratedImage[] = [],
  from: string | null = null,
  mentions: readonly Sent[] = [],
): string | null {
  const link = links.get(key);
  const session = byKey(key);
  if (link === undefined || link.handle === null || session === null) return null;
  if (words.trim() === "" && images.length === 0) return null;
  const note = from === null ? noteFor(key) : null;
  const text = note === null ? words : `${note.text}\n\n${words}`;
  const id = crypto.randomUUID();
  mentionedIn(id, mentions);
  link.conversation.sending(id, text, images);
  link.backSaid = null;
  if (note !== null) notes.set(id, { key, taken: note.deliver, lost: () => {}, untold: note.untold ?? (() => {}) });
  // A message sent is the agent spoken to, by the user or by a session
  // that started it.
  session.engaged = true;
  // The user's own message reads the session and ends a mark on it; a
  // director's leaves the user's mark as it is.
  if (from === null) userWrote(key);
  newTurnLine(session);
  if (from !== null) sentBy(id, from);
  sentAt(id, Date.now());
  // Named by its first line, without the workbench's sentence after a
  // started session's prompt. The workbench's own message names nothing.
  if (session.title === null && givenName(session) === null && from !== WORKBENCH) {
    const line = unsent(spoken(text, from === null).text, mentions)
      .draft.split("\n")
      .find((candidate) => candidate.trim() !== "")
      ?.trim();
    // A first line that reads as another live session's name, or as "You",
    // leaves the row named by its number.
    const title = line === undefined ? null : line.length > 60 ? `${line.slice(0, 59)}…` : line;
    if (title !== null && !nameTaken(title, key) && !reservedName(title)) named(key, title);
  }
  core()
    .integratedSend(link.handle, id, text, images)
    .catch((error) => {
      link.conversation.sendFailed(id, message(error));
      settleNotes(key, link);
    });
  return id;
}

/** Compacts the conversation through the agent's own compaction, with
    what the summary should keep. Resolves true once the core has asked
    for it, and false when it could not, saying why. */
export async function compact(key: string, instructions = ""): Promise<boolean> {
  const link = links.get(key);
  if (link === undefined || link.handle === null) return false;
  const words = instructions.trim();
  link.compactError = null;
  link.compactAsked = link.conversation.current !== null;
  try {
    await core().integratedCompact(link.handle, words === "" ? undefined : words);
    return true;
  } catch (error) {
    link.compactAsked = false;
    link.compactError = message(error);
    return false;
  }
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

/** Why the messages that wait cannot be sent now, in the window's words,
    or null when they can: a turn runs to send them into, nothing waits on
    the user, and no compaction runs, as the core has it. */
export function sendNowBlocked(key: string): string | null {
  const link = links.get(key);
  if (link === undefined || link.handle === null) return "The agent is not running";
  const conversation = link.conversation;
  if (!conversation.waiting.some((message) => message.state === "queued")) return "No message waits";
  if (onTheirWay(key)) return "Sending it now";
  if (conversation.open.length > 0) return "Answer the request below first";
  if (conversation.compacting) return "It goes once the compaction is done";
  if (conversation.current === null) return "It goes as soon as the agent takes it";
  if (conversation.interrupting) return "It goes once the turn has stopped";
  return null;
}

/** Whether the waiting messages were sent now and are on their way into a
    turn: from the asking until the agent takes each, drops it, or says it
    waits again. */
export function onTheirWay(key: string): boolean {
  const link = links.get(key);
  if (link === undefined) return false;
  if (link.sendingNow) return true;
  return link.conversation.waiting.some((message) => message.state === "queued" && link.sentNow.includes(message.id));
}

/** Sends the messages that wait now, in the order sent, the way the
    session's agent takes them: Claude Code takes them into its running
    turn or stops the turn for them, as it decides; Codex has them added to
    its running turn. They stay on their way until the agent takes them. */
export async function sendNow(key: string): Promise<boolean> {
  const link = links.get(key);
  if (link === undefined || link.handle === null) return false;
  if (sendNowBlocked(key) !== null) return false;
  link.nowError = null;
  link.sendingNow = true;
  link.sentNow = link.conversation.waiting.filter((said) => said.state === "queued").map((said) => said.id);
  const turn = link.conversation.current;
  try {
    const sent = await core().integratedSendNow(link.handle);
    // The turn stopped for them ends as interrupted, its end to come; one
    // that has ended, or the next that has begun, is left as it is.
    if (sent.sendNow === "stopped" && turn !== null && link.conversation.current === turn)
      link.conversation.interrupting = true;
    if (sent.sendNow === "nothingWaiting") link.sentNow = [];
    return true;
  } catch (error) {
    link.sentNow = [];
    link.nowError = `Not sent now: ${message(error)}`;
    return false;
  } finally {
    link.sendingNow = false;
  }
}

/** Takes back a message the agent has not taken yet. Its words and images
    go back to the composer when the agent lets go of it, whatever comes of
    the asking, and stay in the thread while it has not. Resolves false,
    saying why, when the agent took it first. */
export async function takeBack(key: string, id: string): Promise<boolean> {
  const link = links.get(key);
  const said = link?.conversation.messages[id];
  if (link === undefined || link.handle === null || said === undefined) return false;
  link.nowError = null;
  link.takingBack.set(id, { ...said, images: [...said.images] });
  try {
    await core().integratedWithdraw(link.handle, id);
    return true;
  } catch (error) {
    link.takingBack.delete(id);
    // Let go of after all, as when the agent dropped it with others: its
    // words are back already.
    if (link.conversation.messages[id] === undefined) return true;
    link.nowError = `Not taken back: ${message(error)}`;
    return false;
  }
}

/** Puts a message's words, mentions and images back in the session's
    composer, ahead of what is written there, with the keyboard on it and
    the caret where `caret` says. One that never stood in the thread leaves
    it. One Up took back, while the composer holds only what Up took back,
    goes among those in the order they were sent, with the caret at the
    start. */
export function restore(key: string, said: Message, caret: "start" | "end" | null = null) {
  const link = links.get(key);
  if (link === undefined) return;
  const back = unsent(spoken(said.text, senderOf(said) === null).text, mentionsOf(said.id));
  const chain = link.upChain;
  if (chain !== null && chain.ids.includes(said.id) && link.draft === chain.draft) {
    chain.back[said.id] = { draft: back.draft, mentions: back.picked, images: [...said.images] };
    const kept = chain.ids.flatMap((id) => chain.back[id] ?? []);
    link.draft = kept.map((one) => one.draft).join("\n");
    link.mentions = [...new Set(kept.flatMap((one) => one.mentions))];
    link.images = kept.flatMap((one) => one.images);
    chain.draft = link.draft;
    caret = "start";
  } else {
    if (chain !== null && link.draft !== chain.draft) link.upChain = null;
    link.draft = link.draft.trim() === "" ? back.draft : `${back.draft}\n${link.draft}`;
    link.mentions = [...new Set([...link.mentions, ...back.picked])];
    link.images = [...said.images, ...link.images];
  }
  if (!said.placed) link.conversation.forget(said.id);
  void tick().then(() => {
    const field = document.querySelector<HTMLTextAreaElement>(
      `[data-session="${key}"] [data-testid="composer-input"]`,
    );
    field?.focus();
    if (field !== null && caret !== null) {
      const at = caret === "start" ? 0 : field.value.length;
      field.setSelectionRange(at, at);
    }
  });
}

/**
 * Up in the composer takes a waiting message of the user's own back: with
 * the composer holding nothing, the newest; with it holding only what Up
 * took back, unchanged, the one before those. `own` says which messages
 * are the user's own. None that is on its way already, or being taken
 * back, is taken. False when there is none to take, or the composer holds
 * something else, and Up does what it does in a field.
 */
export function takeBackUp(key: string, own: (message: Message) => boolean): boolean {
  const link = links.get(key);
  if (link === undefined || link.handle === null || onTheirWay(key)) return false;
  const empty = link.draft.trim() === "" && link.images.length === 0 && link.files.length === 0;
  const chain = link.upChain;
  const going = chain !== null && link.draft === chain.draft && (chain.draft !== "" || chain.ids.length > 0);
  if (!going && !empty) return false;
  const order = link.conversation.order;
  const oldest = going ? chain.from : order.length;
  const next = link.conversation.waiting.findLast(
    (message) =>
      message.state === "queued" &&
      own(message) &&
      !link.takingBack.has(message.id) &&
      order.indexOf(message.id) < oldest,
  );
  if (next === undefined) return false;
  const from = order.indexOf(next.id);
  link.upChain = going
    ? { ...chain, ids: [next.id, ...chain.ids], from }
    : { ids: [next.id], back: {}, from, draft: link.draft };
  void takeBack(key, next.id);
  return true;
}

/** Whether Up, pressed again, has one before to take back: the composer
    holds only what Up took back, and an older message of the user's own
    waits that is not being taken back. */
export function upHasMore(key: string, own: (message: Message) => boolean): boolean {
  const link = links.get(key);
  const chain = link?.upChain ?? null;
  if (link === undefined || chain === null || link.draft !== chain.draft || chain.ids.length === 0) return false;
  const order = link.conversation.order;
  return link.conversation.waiting.some(
    (message) =>
      message.state === "queued" &&
      own(message) &&
      !link.takingBack.has(message.id) &&
      order.indexOf(message.id) < chain.from,
  );
}

/** Whether the composer holds only what Up took back, as Up left it. */
export function upHolds(key: string): boolean {
  const link = links.get(key);
  const chain = link?.upChain ?? null;
  return link !== undefined && chain !== null && chain.draft !== "" && link.draft === chain.draft;
}

/** How a conversation goes back to before a message, as the user chose:
    the conversation alone, the conversation and the files, or only the
    files. */
export type BackWay = "conversation" | "both" | "files";

/** Files by their names, the last part of each path, joined with an and,
    the rest counted past three. */
export function fileNames(files: string[]): string {
  const names = files.map((file) => file.replaceAll("\\", "/").split("/").pop() ?? file);
  if (names.length > 3) return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The time of day a message was sent, as the thread shows it. */
function timeOf(at: number | null): string {
  return at === null ? "then" : timeOfDay(at);
}

/**
 * Takes a session at rest back to before a message of the user's, the way
 * chosen, with `shown` the files a preview showed the user, which are those
 * put back. Going back with the conversation cuts the thread before the
 * message and puts its words in the composer ahead of what is there at
 * once, so they can be edited while the core goes back; where it does not
 * go back, the thread is whole again and the words leave the composer
 * where they stand unchanged. While the core goes back the session takes
 * no message: what is sent waits, as for a session starting again, and
 * goes only where it went back. What the run says meanwhile waits too: a
 * Claude Code session is started again under a new id, and the run gone
 * back from has ended by the time the core answers. Resolves to why it
 * did not go back, or null.
 */
export async function goBack(key: string, id: string, way: BackWay, shown: string[]): Promise<string | null> {
  const link = links.get(key);
  const session = byKey(key);
  const said = link?.conversation.messages[id];
  if (link === undefined || session === null || link.handle === null) return "The session is not running.";
  if (said === undefined) return "That message is not in the conversation.";
  if (link.goingBack !== null) return "It is going back already.";
  const handle = link.handle;
  const conversation = way !== "files";
  const restarts = conversation && session.agent === "claude-code";
  const asked = { message: { ...said, images: [...said.images] }, way };
  link.nowError = null;
  link.backSaid = null;
  link.held = [];
  if (restarts) link.restarting = true;
  link.goingBack = { ...asked, gone: conversation ? cutBack(key, link, asked.message) : [] };
  let went: Awaited<ReturnType<ReturnType<typeof core>["integratedRewind"]>>;
  try {
    went = await core().integratedRewind(handle, id, { conversation, files: way === "conversation" ? null : shown });
  } catch (error) {
    missedBack(link);
    settleBack(key, link, link.held ?? []);
    link.goingBack = null;
    return message(error);
  }
  const held = link.held ?? [];
  if (went.id !== handle) {
    // The run gone back from has ended; what it said last is let go.
    byHandle.delete(handle);
    link.handle = null;
    if (went.id === null) {
      missedBack(link);
      settleBack(key, link, held);
      link.goingBack = null;
      const why = `${agentName(session)} could not start again: ${went.error ?? "no reason was given"}.`;
      link.conversation.apply({ type: "error", kind: "process", message: why });
      return why;
    }
    link.handle = went.id;
    byHandle.set(went.id, key);
    if (went.fallback !== null) missedBack(link);
    settleBack(key, link, claim(went.id));
    if (went.sessionId !== null) identify(session, went.sessionId);
  } else settleBack(key, link, held);
  link.goingBack = null;
  const at = timeOf(said.at);
  if (went.fallback !== null) {
    link.backSaid = `It did not go back: ${went.fallback}. The conversation goes on as it was.`;
    return went.fallback;
  }
  if (went.files.length > 0)
    link.backSaid = `${fileNames(went.files)} ${went.files.length === 1 ? "is" : "are"} as ${went.files.length === 1 ? "it was" : "they were"} at ${at}. What commands changed stays.`;
  // Claude Code's going back of the conversation alone can be undone, until
  // anything is said from there.
  if (restarts && went.files.length === 0) link.conversation.undoable(true);
  return null;
}

/** The name the agent goes by, for what the window says of it. */
function agentName(session: Session): string {
  return session.agent === "codex" ? "Codex" : "Claude Code";
}

/** Plays what a run said while going back was asked, and lets the session
    take messages again. */
function settleBack(key: string, link: Link, events: IntegratedEventBody[]) {
  link.held = null;
  link.restarting = false;
  for (const body of events) deliver(key, link, body);
}

/** Cuts the thread before the message going back is to, and puts its
    words in the composer ahead of what is there, the caret at the end;
    returns the messages that left the thread. */
function cutBack(key: string, link: Link, said: Message): string[] {
  const gone = link.conversation.rewound(said.id, clock());
  const before = { draft: link.draft, images: link.images, mentions: link.mentions, files: link.files };
  link.upChain = null;
  restore(key, { ...said, placed: true }, "end");
  link.backDraft = { after: link.draft, before };
  return gone;
}

/** The conversation did not go back: the thread is whole again, the
    composer is as it was where the words going back put there stand
    unchanged, and a send held for going back does not go. */
function missedBack(link: Link) {
  if (link.goingBack === null || link.goingBack.way === "files") return;
  link.backMissed += 1;
  link.conversation.unrewound();
  putBackDraft(link);
}

/** The composer as it was before going back, where the words it put
    there stand unchanged. */
function putBackDraft(link: Link) {
  const kept = link.backDraft;
  link.backDraft = null;
  if (kept === null || link.draft !== kept.after) return;
  link.draft = kept.before.draft;
  link.images = kept.before.images;
  link.mentions = kept.before.mentions;
  link.files = kept.before.files;
}

/** The session went back: the conversation is cut before the message,
    where the window that asked has not cut it already, and the reports
    the messages that left carried count as not told again. */
function wentBack(link: Link, body: Extract<IntegratedEventBody, { type: "rewound" }>) {
  if (!body.conversation) return;
  const asked = link.goingBack?.message.id === body.message ? link.goingBack : null;
  const gone = asked?.gone ?? link.conversation.rewound(body.message, clock());
  for (const id of gone) {
    toldBy.get(id)?.();
    toldBy.delete(id);
  }
}

/** Undoes going back that started the session again: it starts again on
    the conversation as it was, which comes back to the thread, and the
    words going back put in the composer leave it where they stand
    unchanged. Resolves to why it was not undone, or null. */
export async function undoGoBack(key: string): Promise<string | null> {
  const link = links.get(key);
  const session = byKey(key);
  if (link === undefined || session === null || link.handle === null) return "The session is not running.";
  const handle = link.handle;
  link.held = [];
  link.restarting = true;
  let went: Awaited<ReturnType<ReturnType<typeof core>["integratedRewindUndo"]>>;
  try {
    went = await core().integratedRewindUndo(handle);
  } catch (error) {
    settleBack(key, link, link.held ?? []);
    link.nowError = `Not undone: ${message(error)}`;
    return message(error);
  }
  const held = link.held ?? [];
  byHandle.delete(handle);
  link.handle = null;
  if (went.id === null) {
    settleBack(key, link, held);
    const why = `${agentName(session)} could not start again: ${went.error ?? "no reason was given"}.`;
    link.conversation.apply({ type: "error", kind: "process", message: why });
    return why;
  }
  link.handle = went.id;
  byHandle.set(went.id, key);
  link.conversation.unrewound();
  settleBack(key, link, claim(went.id));
  if (went.sessionId !== null) identify(session, went.sessionId);
  putBackDraft(link);
  link.backSaid = null;
  return null;
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
export async function configure(key: string, change: Change) {
  const link = links.get(key);
  if (link === undefined) return;
  if (change.mode !== undefined) link.modeChosen = true;
  // A run a reopen is stopping takes nothing more: a mode chosen meanwhile
  // is the one the next run starts in, the other way.
  if (reopeningRow(key)) {
    const id = byKey(key)?.id ?? null;
    if (change.mode !== undefined && id !== null && offers(link, change.mode)) {
      keepMode(id, change.mode, true);
      link.conversation.settings = { ...link.conversation.settings, mode: change.mode };
    }
    return;
  }
  const handle = link.handle;
  if (handle === null) {
    // Made on the new run once it is up.
    if (link.restarting) link.after = { ...link.after, ...change };
    return;
  }
  link.configureError = null;
  link.unanswered.add(change);
  try {
    const settings = await core().integratedConfigure(handle, change);
    // A run since left behind answers for itself, not for the one now
    // behind the row.
    if (link.handle === handle) link.conversation.settings = settings;
  } catch (error) {
    if (link.handle === handle) link.configureError = message(error);
  } finally {
    link.unanswered.delete(change);
  }
}

/** The row is closed: its agent is stopped, and its last words let go. */
function stop(session: Session) {
  const link = links.get(session.key);
  links.delete(session.key);
  settleNotes(session.key, undefined);
  if (link?.handle === null || link === undefined) return;
  const handle = link.handle;
  byHandle.delete(handle);
  stopped.add(handle);
  core()
    .integratedStop(handle)
    .catch(() => stopped.delete(handle));
}

onIntegratedClose(stop);

/** The row's agent is stopped and the row kept: its run ends as any run
    does, its end told by the core. */
function halt(session: Session) {
  const link = links.get(session.key);
  if (link === undefined || link.handle === null) {
    runEnded(session.key);
    return;
  }
  // A mode asked of the run and not answered yet is the user's last choice,
  // which the next run starts in.
  const asked: Change = Object.assign({}, ...link.unanswered);
  if (asked.mode !== undefined && session.id !== null && offers(link, asked.mode))
    keepMode(session.id, asked.mode, true);
  const handle = link.handle;
  core()
    .integratedStop(handle)
    .catch(() => {
      // Gone already: no end will be told of it.
      if (link.handle === handle) ended(session, link, null, true);
    });
}

onIntegratedHalt(halt);

// Anything said in a conversation, or before it in an earlier run, is
// there to resume; one never spoken to, nothing read before it, is not.
onSaid((session) => {
  const link = links.get(session.key);
  return session.resumedFrom !== null || session.prompt !== null || link === undefined || !link.conversation.untouched;
});

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
  notes.clear();
  toldBy.clear();
  clock = time;
}
