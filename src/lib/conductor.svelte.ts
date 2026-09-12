/**
 * The tools a session gets for directing other sessions.
 *
 * An agent calls them where it runs; the core carries each call to the
 * window as a request and waits for exactly one answer to it. The window
 * is where the projects and the sessions are, so the work and the
 * answering are here. Every answer is plain lines for an agent to read.
 *
 * Starting a session is the one call the user is brought into. The first
 * time a caller asks to start one in a project the window puts the
 * question up and holds the call until it is answered, and an allowed
 * caller is remembered for that project for as long as the window lives.
 * Calls that arrive while a question is up wait their turn.
 *
 * A session may start others, and those may not start any of their own:
 * one level deep, and no more than the cap at a time, so a loop of agents
 * starting agents cannot run away with the machine.
 */

import { core, type AgentId, type ConductRequest } from "$lib/core";
import {
  byKey,
  close,
  create,
  defaultAgent,
  isLive,
  label,
  sessions,
  statusMessage,
  type Session,
} from "$lib/sessions.svelte";
import { within } from "$lib/show.svelte";
import { printable } from "$lib/terminals.svelte";
import { workspace } from "$lib/workspace.svelte";

/** How many sessions one caller may have running at a time. */
export const CAP = 8;
/** How long a wait runs when the call names no seconds, and the most it
    runs whatever it names. The core gives up on the same clock. */
export const WAIT_SECONDS = 600;
export const WAIT_MAX = 1800;
/** How long a start waits for the new session to come up and say its id.
    Inside the minute the core gives the window to answer. */
export const START_WAIT = 30_000;
/** How long after a started session comes up its first prompt is typed:
    an agent still drawing its own start-up swallows a line sent into it. */
export const PROMPT_AFTER = 400;

/** The question on screen: which call it holds, who asked, and what for. */
export interface Ask {
  request: ConductRequest;
  /** What the calling session is called, for the title. */
  caller: string;
  project: string;
  /** The prompt's first line. */
  prompt: string;
  worktree: boolean;
}

/** What the user answered: allowed from now on, allowed this once, or no. */
export type Choice = "allow" | "once" | "no";

export const conductor = $state({
  asking: null as Ask | null,
  /** The session that started each one, by the started session's key and
      the starter's session id. */
  startedBy: {} as Record<string, string>,
});

/** Callers with a standing answer, by caller and project. */
const allowed = new Set<string>();
/** Questions waiting for the one on screen to be answered. */
const queue: { ask: Ask; settle: (choice: Choice) => void }[] = [];
let pending: ((choice: Choice) => void) | null = null;
/** Worktree names this window has asked for, by project. */
const named = new Map<string, string[]>();

interface Answered {
  content: string | null;
  error: string | null;
}

const said = (content: string): Answered => ({ content, error: null });
const refused = (error: string): Answered => ({ content: null, error });

/**
 * Answers one call. Every call is answered exactly once, whatever
 * happens: the agent on the other side is blocked until it is.
 */
export async function handle(request: ConductRequest): Promise<void> {
  let answered: Answered;
  try {
    answered = await run(request);
  } catch (error) {
    answered = refused(String(error));
  }
  await core()
    .conductAnswer(request.id, answered.content, answered.error)
    .catch(() => {
      // The core has gone, or the call had already given up. Nothing here
      // can tell the agent either way.
    });
}

function run(request: ConductRequest): Answered | Promise<Answered> {
  switch (request.tool) {
    case "projects":
      return said(projectLines(request));
    case "sessions":
      return said(sessionLines(request));
    case "start":
      return startSession(request);
    case "send":
      return sendText(request);
    case "stop":
      return stopSession(request);
    case "wait":
      return waitFor(request);
    case "read":
      return readSession(request);
    default:
      return refused(`The workbench has no ${String(request.tool)} tool.`);
  }
}

/** The open projects, the caller's own marked. */
function projectLines(request: ConductRequest): string {
  if (workspace.open.length === 0)
    return "No projects are open in the workbench.";
  const here = projectOf(request.cwd);
  return workspace.open
    .map((project) =>
      [project.path, project.name, project.path === here ? "(this one)" : null]
        .filter((part) => part !== null)
        .join("  "),
    )
    .join("\n");
}

/** The open project a directory is in: the deepest one it lies under. */
function projectOf(cwd: string): string | null {
  return (
    workspace.open
      .map((project) => project.path)
      .filter((path) => within(cwd, path))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

/** The sessions, one project's or all of them. A session with no id yet
    is left out: the id is how the agent names one. */
function sessionLines(request: ConductRequest): string {
  const only = text(request, "project");
  const listed = sessions.all.filter(
    (session) =>
      session.id !== null && (only === null || session.project === only),
  );
  if (listed.length === 0) return "No sessions are open in the workbench.";
  return listed.map(describe).join("\n");
}

function describe(session: Session): string {
  const parts = [session.id ?? "", label(session), session.project];
  const tree = session.worktree ?? session.startIn;
  if (tree !== null && tree !== session.project) parts.push(`worktree ${tree}`);
  parts.push(session.agent, stateOf(session));
  if (session.note !== null) parts.push(`last line: ${session.note}`);
  return parts.join("  ");
}

/** What a session is doing, in the words the tools answer in. */
export function stateOf(session: Session): string {
  switch (session.status) {
    case "starting":
      return "starting";
    case "exited":
      return "exited";
    case "crashed":
    case "failed":
      return "stopped";
    default:
      if (session.needs === "permission") return "asking for permission";
      return session.working ? "working" : "waiting";
  }
}

/** Starts a session for the caller, once the user allows it. */
async function startSession(request: ConductRequest): Promise<Answered> {
  const project = text(request, "project");
  const prompt = text(request, "prompt");
  if (project === null) return refused("Starting a session needs a project.");
  if (prompt === null)
    return refused("Starting a session needs a prompt to give it.");
  if (!workspace.open.some((open) => open.path === project))
    return refused(`No project at ${project} is open in the workbench.`);
  const caller = callerOf(request);
  if (startedBy(caller).filter(isLive).length >= CAP)
    return refused(
      `You have ${CAP} sessions running already, which is as many as one session may have. Stop one before starting another.`,
    );
  if (startedFor(callerKey(request)) !== null)
    return refused(
      "A session that another session started cannot start sessions of its own.",
    );

  const wants = flag(request, "worktree");
  if ((await askUser(request, project, prompt, wants)) === "no")
    return refused("The user did not allow the session to be started.");

  let startIn: string | null = null;
  if (wants) {
    const taken = named.get(project) ?? [];
    const name = worktreeName(prompt, taken);
    named.set(project, [...taken, name]);
    try {
      startIn = await core().worktreeAdd(project, name);
    } catch (error) {
      return refused(`The worktree could not be made: ${String(error)}`);
    }
  }

  const session = create(project, null, agentOf(request, project), startIn);
  conductor.startedBy[session.key] = caller;
  void typePrompt(session.key, prompt);

  const id = await idFor(session.key);
  if (id === null) {
    const row = byKey(session.key);
    return refused(
      row === null
        ? "The session was closed before it started."
        : statusMessage(row),
    );
  }
  const where = startIn === null ? project : `${project}, in ${startIn}`;
  return said(
    `Started session ${id} in ${where}. It has the prompt. Call wait to hear how it goes.`,
  );
}

/**
 * A worktree's name, from the prompt that asked for it: its words in
 * lowercase joined by dashes, cut to 40 characters, and a number on the
 * end when the window has asked for that name in the project before.
 */
export function worktreeName(prompt: string, taken: string[] = []): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let cut = words.slice(0, 40);
  // A cut that landed inside a word takes the whole word with it, so the
  // name reads as words rather than ending mid-one.
  if (words.length > 40 && words[40] !== "-") {
    const boundary = cut.lastIndexOf("-");
    if (boundary > 0) cut = cut.slice(0, boundary);
  }
  const base = cut.replace(/-+$/, "") || "session";
  if (!taken.includes(base)) return base;
  let next = 2;
  while (taken.includes(`${base}-${next}`)) next += 1;
  return `${base}-${next}`;
}

/** The first prompt, typed into the session once it is up. */
async function typePrompt(key: string, prompt: string) {
  const line = oneLine(prompt);
  if (line === "") return;
  if (!(await upAndRunning(key))) return;
  await pause(PROMPT_AFTER);
  const session = byKey(key);
  if (session === null || session.ptyId === null) return;
  await core()
    .write(session.ptyId, `${line}\r`)
    .catch(() => {
      // The session went while the prompt was on its way in. The caller
      // hears that from wait, not from here.
    });
}

async function sendText(request: ConductRequest): Promise<Answered> {
  const id = text(request, "session");
  const line = text(request, "text");
  if (id === null) return refused("Sending needs a session to send to.");
  if (line === null) return refused("Sending needs the text to send.");
  const session = byId(id);
  if (session === null) return refused(`The workbench has no session ${id}.`);
  if (session.status !== "running" || session.ptyId === null)
    return refused(`Session ${id} is not running.`);
  await core().write(session.ptyId, `${oneLine(line)}\r`);
  return said(`Sent to session ${id}. Call wait to hear what it does next.`);
}

function stopSession(request: ConductRequest): Answered {
  const id = text(request, "session");
  if (id === null) return refused("Stopping needs a session to stop.");
  const session = byId(id);
  if (session === null) return refused(`The workbench has no session ${id}.`);
  close(session.key);
  return said(`Stopped session ${id}.`);
}

/**
 * Waits for a session to come to rest: it stops working, it asks for
 * permission, or it ends. With no session named, for whichever of the
 * caller's own does so first.
 */
async function waitFor(request: ConductRequest): Promise<Answered> {
  const id = text(request, "session");
  const seconds = number(request, "seconds", WAIT_SECONDS, WAIT_MAX);
  let watched: Session[];
  if (id === null) {
    watched = startedBy(callerOf(request));
    if (watched.length === 0)
      return refused(
        "You have started no sessions to wait for. Name one to wait for it, or start one first.",
      );
  } else {
    const session = byId(id);
    if (session === null) return refused(`The workbench has no session ${id}.`);
    watched = [session];
  }

  // What each one was doing when the wait began: what is worth answering
  // is a change from here, so a session at work is waited out rather than
  // answered for at once.
  const worked = new Map<string, boolean>();
  const names = new Map<string, string>();
  for (const session of watched) {
    worked.set(session.key, session.working);
    names.set(session.key, session.id ?? label(session));
  }

  const happened = await settles<string | null>(
    (settle) => {
      for (const key of worked.keys()) {
        const name = names.get(key) ?? key;
        const session = byKey(key);
        if (session === null) {
          settle(`Session ${name} was closed.`);
          return;
        }
        if (!isLive(session)) {
          settle(`Session ${name} ${stateOf(session)}. ${lastLine(session)}`);
          return;
        }
        if (session.needs === "permission") {
          settle(
            `Session ${name} is asking for permission. ${lastLine(session)}`,
          );
          return;
        }
        if (session.working) worked.set(key, true);
        else if (worked.get(key) === true) {
          settle(`Session ${name} stopped working. ${lastLine(session)}`);
          return;
        }
      }
    },
    seconds * 1000,
    null,
  );
  if (happened === null)
    return said(
      `Nothing happened within ${seconds} seconds: no session stopped and none asked anything.`,
    );
  return said(happened);
}

/**
 * The turns of a session. Nothing here can read them: an agent's
 * transcript is its own, in a format it documents as internal, and the
 * workbench reads only the names and dates of the files. So the answer is
 * the line the session left and a word about what it is not.
 */
function readSession(request: ConductRequest): Answered {
  const id = text(request, "session");
  if (id === null) return refused("Reading needs a session to read.");
  const session = byId(id);
  if (session === null) return refused(`The workbench has no session ${id}.`);
  return said(
    `The workbench cannot read a session's turns: an agent's transcript is not readable from here. ${lastLine(session)} Send it a line to ask it something.`,
  );
}

/** A line as the agent's own keyboard would deliver it: one line, with
    nothing in it that could drive the terminal instead of being read. */
function oneLine(text: string): string {
  return printable(text.replace(/[\r\n]+/g, " ")).trim();
}

/** What a session last left for its row. */
function lastLine(session: Session): string {
  return session.note === null
    ? "It has left no line."
    : `Its last line: ${session.note}`;
}

/** The id of the session that started this one, when one did. */
export function startedFor(key: string | null): string | null {
  if (key === null) return null;
  return conductor.startedBy[key] ?? null;
}

/** The sessions a session started, running or not. */
export function startedBy(sessionId: string): Session[] {
  return sessions.all.filter(
    (session) => conductor.startedBy[session.key] === sessionId,
  );
}

/** Closes every session a session started. */
export function stopAll(sessionId: string) {
  for (const session of startedBy(sessionId)) close(session.key);
}

/** Who is calling: the session it runs as, else the directory it runs in. */
function callerOf(request: ConductRequest): string {
  return request.session ?? request.cwd;
}

/** The calling session's row key, when the call names a session this
    window has. */
function callerKey(request: ConductRequest): string | null {
  if (request.session === null) return null;
  return byId(request.session)?.key ?? null;
}

function byId(sessionId: string): Session | null {
  return sessions.all.find((session) => session.id === sessionId) ?? null;
}

/** The agent to run: the one the call named when it is one the workbench
    drives, else the project's own. */
function agentOf(request: ConductRequest, project: string): AgentId {
  const wanted = text(request, "agent");
  if (wanted === "claude-code" || wanted === "codex") return wanted;
  return defaultAgent(project);
}

/**
 * Puts the question to the user, unless this caller already has a
 * standing answer for the project. A question that arrives while another
 * is up waits behind it.
 */
function askUser(
  request: ConductRequest,
  project: string,
  prompt: string,
  worktree: boolean,
): Promise<Choice> {
  const caller = callerOf(request);
  if (allowed.has(`${caller}\n${project}`)) return Promise.resolve("allow");
  const session = request.session === null ? null : byId(request.session);
  const ask: Ask = {
    request,
    caller: session === null ? "A session" : label(session),
    project,
    prompt: prompt.split("\n")[0],
    worktree,
  };
  return new Promise<Choice>((settle) => {
    queue.push({ ask, settle });
    nextAsk();
  });
}

function nextAsk() {
  if (conductor.asking !== null) return;
  const head = queue.shift();
  if (head === undefined) return;
  conductor.asking = head.ask;
  pending = head.settle;
}

function answerAsk(choice: Choice) {
  const ask = conductor.asking;
  const settle = pending;
  conductor.asking = null;
  pending = null;
  if (ask !== null && choice === "allow")
    allowed.add(`${callerOf(ask.request)}\n${ask.project}`);
  settle?.(choice);
  nextAsk();
}

/** This caller may start sessions in this project from now on. */
export function allow() {
  answerAsk("allow");
}

/** This one session, and the question again next time. */
export function once() {
  answerAsk("once");
}

/** No session, and the caller hears it as a refusal. */
export function refuse() {
  answerAsk("no");
}

/** The id of a session once it has one, or null when it never came up. */
function idFor(key: string): Promise<string | null> {
  return settles<string | null>(
    (settle) => {
      const session = byKey(key);
      if (session === null) {
        settle(null);
        return;
      }
      if (session.id !== null) settle(session.id);
      else if (session.status !== "starting") settle(null);
    },
    START_WAIT,
    null,
  );
}

/** Whether a session came up at all. */
function upAndRunning(key: string): Promise<boolean> {
  return settles<boolean>(
    (settle) => {
      const session = byKey(key);
      if (session === null) settle(false);
      else if (session.status === "running" && session.ptyId !== null)
        settle(true);
      else if (session.status !== "starting") settle(false);
    },
    START_WAIT,
    false,
  );
}

/**
 * A promise the session rows settle. The test runs whenever anything it
 * read changes, so nothing here polls the store; the timer is only the
 * cap on how long the caller is held.
 */
function settles<T>(
  test: (settle: (value: T) => void) => void,
  ms: number,
  onTimeout: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    let stop: (() => void) | null = null;
    const timer = setTimeout(() => settle(onTimeout), ms);
    function settle(value: T) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Torn down after the effect that is settling has finished running.
      void Promise.resolve().then(() => stop?.());
      resolve(value);
    }
    stop = $effect.root(() => {
      $effect(() => test(settle));
    });
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A string argument, trimmed. Null when it is missing or empty. */
function text(request: ConductRequest, name: string): string | null {
  const value = request.arguments[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function flag(request: ConductRequest, name: string): boolean {
  const value = request.arguments[name];
  return value === true || value === "true";
}

/** A whole number argument, within what the tool offers. */
function number(
  request: ConductRequest,
  name: string,
  fallback: number,
  most: number,
): number {
  const value = request.arguments[name];
  const asked =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(asked) || asked < 1) return fallback;
  return Math.min(Math.floor(asked), most);
}

/** Test seam. */
export function resetConductor() {
  conductor.asking = null;
  for (const key of Object.keys(conductor.startedBy))
    delete conductor.startedBy[key];
  pending = null;
  queue.length = 0;
  allowed.clear();
  named.clear();
}
