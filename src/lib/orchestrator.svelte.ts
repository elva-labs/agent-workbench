/**
 * The orchestrator, as the panes show it.
 *
 * A session that directs others is a session like any other: an agent in a
 * project, on the same keys and in the same panes. Any session may start
 * others, and one that follows a workflow is its orchestrator.
 *
 * The sessions a session starts hang under it in the pane, one line each
 * on a rail from its dot, wherever they run, and speak up only when one of
 * them needs a permission. The place to go is the session that started
 * them, not the session it started.
 */

import { dirsOf } from "$lib/accounts.svelte";
import { parentsFrom, resumesWords } from "$lib/autoResume.svelte";
import { core, type Worktree } from "$lib/core";
import {
  allowedProjects,
  oneLine,
  placeTextOf,
  startedFor,
  treeRemoved,
  treesMadeBy,
  typeLine,
} from "$lib/conductor.svelte";
import { handleOf, linkFor, send as sendIntegrated } from "$lib/integrated.svelte";
import { lastSegment } from "$lib/paths";
import { isLive, label, lastChanged, sessions, since, statusLabel, type Session } from "$lib/sessions.svelte";
import { shown } from "$lib/unseen";
import { projectLabel, workspace } from "$lib/workspace.svelte";
import { drawnWith } from "$lib/projects.svelte";

/** A started session that is waiting on the user: it needs a permission,
    which only the user can grant. Everything else it waits on is its
    orchestrator's to hear, so its row speaks up for nothing else. */
export function isAsking(session: Session): boolean {
  return isLive(session) && session.needs === "permission";
}

/** The rows by token, the live one taking a token a row that has
    stopped holds as well, else the first in the window's order. */
const named = $derived.by(() => {
  const index = new Map<string, Session>();
  for (const session of sessions.all) {
    const held = index.get(session.token);
    if (held === undefined || (!isLive(held) && isLive(session)))
      index.set(session.token, session);
  }
  return index;
});

/** Each session's starter row, the rows each starter has hanging under it
    and the rows each caller started, worked out once for all of them
    whenever a row comes, goes or is told who started it. */
const tree = $derived.by(() => {
  const parents = new Map<string, Session>();
  const children = new Map<string, Session[]>();
  const started = new Map<string, Session[]>();
  const own = new Map<string, Session[]>();
  for (const session of sessions.all) {
    const id = startedFor(session.key);
    if (id !== null) {
      const list = started.get(id);
      if (list === undefined) started.set(id, [session]);
      else list.push(session);
    }
    const parent = id === null ? null : starterOf(session, id);
    if (parent === null) {
      const list = own.get(session.project);
      if (list === undefined) own.set(session.project, [session]);
      else list.push(session);
      continue;
    }
    parents.set(session.key, parent);
    const list = children.get(parent.key);
    if (list === undefined) children.set(parent.key, [session]);
    else list.push(session);
  }
  return { parents, children, started, own };
});

/** The row a starter's token names, other than the session's own. */
function starterOf(session: Session, token: string): Session | null {
  const found = named.get(token);
  if (found === undefined) return null;
  if (found !== session) return found;
  return (
    sessions.all.find((candidate) => candidate !== session && candidate.token === token) ?? null
  );
}

/** What one orchestrator has running, for the line under its name and its
    dot: how many are live, how many are waiting on you, and whether any is
    at work right now. */
export function summary(session: Session): {
  running: number;
  asking: number;
  working: boolean;
} {
  const started = tree.started.get(session.token) ?? [];
  return {
    running: started.filter(isLive).length,
    asking: started.filter(isAsking).length,
    working: started.some((child) => isLive(child) && child.working),
  };
}

/** Whether an orchestrator's dot should breathe: its own agent is at work,
    or one it started is. A child that is asking shows in the summary line
    and the fold's accent rather than here, so it does not stop the dot. The
    orchestrator's own call for attention does: its permission ring or its
    unread accent is the row's state, and a working child does not paint
    over it. */
export function conducting(session: Session): boolean {
  if (session.working) return true;
  if (session.unread || session.needs === "permission") return false;
  return summary(session).working;
}

/** What a session is doing, in the words every place that says it uses:
    the status bar, a row's words and its dot's hover, a started session's
    line. It decides as the dot does, so a session at rest while
    sessions it started work says how many of them do rather than idle. */
export function stateWord(session: Session | null): string {
  if (session !== null && session.status === "running" && session.workflowLost === null && !session.working && conducting(session)) {
    const count = startedRows(session).filter((child) => isLive(child) && child.working).length;
    return count === 1 ? "a session working" : `${count} sessions working`;
  }
  // At rest on a usage limit it goes on after by itself: when.
  if (session !== null && !session.working && session.needs === null) {
    const resumes = resumesWords(session);
    if (resumes !== null) return resumes;
  }
  return statusLabel(session);
}

/** What the status bar says the session on screen is doing: its state
    word, or for an integrated session waiting on the user before it can
    run, what it waits for, and while it asks, whether it asks a question
    or a permission. */
export function sessionState(session: Session | null): string {
  if (session !== null && session.kind === "integrated") {
    const link = linkFor(session.key);
    if (link.untrusted) return "asks to trust the folder";
    if (link.conversation.notLoggedIn) return "not signed in";
    if (session.status === "running" && session.needs === "permission")
      return link.conversation.open[0]?.asked.type === "questionAsked" ? "asks you" : "waits for permission";
  }
  return stateWord(session);
}

/** The line under an orchestrator's name: what it has out, and how much of
    it is waiting on you. */
export function summaryLine(session: Session): string | null {
  const { running, asking } = summary(session);
  if (running === 0) return null;
  return asking === 0
    ? `${running} running`
    : `${running} running, ${asking} asking`;
}

/** The row of the session that started this one, while the window has
    it. A session whose starter is gone has no parent here and stands in
    its own project like any other. */
export function parentOf(session: Session): Session | null {
  return tree.parents.get(session.key) ?? null;
}

/** The sessions that hang under a session's row, in the order they were
    started. */
export function childrenOf(session: Session): Session[] {
  return tree.children.get(session.key) ?? [];
}

/** The sessions drawn under a project's name: its own, and any whose
    starter the window no longer has. A session started by one still here
    hangs under that one instead, whichever project it runs in. */
export function ownFor(project: string): Session[] {
  return tree.own.get(project) ?? [];
}

drawnWith({ ownFor, childrenOf, parentOf });

/** A worktree found under a project, with the project it is under. */
export type LeftTree = Worktree & { project: string };

/**
 * The worktrees of the open projects that nothing is running in.
 *
 * A start that asked for a worktree leaves one behind when the session it
 * was made for ends, so the board says how many are there and offers to
 * take away the ones git will part with.
 */
export const leftBehind = $state<{ trees: LeftTree[]; loading: boolean }>({
  trees: [],
  loading: false,
});

/** The trees that can go: the branch holds nothing the project's own lacks,
    and there is no uncommitted work in the tree. */
export function removable(trees: LeftTree[]): LeftTree[] {
  return trees.filter((tree) => tree.merged && !tree.dirty);
}

/** Asks every open project for its worktrees and keeps the ones no live
    session is running in. A project that cannot say is passed over. */
export async function readWorktrees(): Promise<void> {
  const projects = workspace.open.map((project) => project.path);
  leftBehind.loading = true;
  try {
    const found: LeftTree[] = [];
    for (const project of projects) {
      let trees: Worktree[];
      try {
        trees = await core().worktrees(project);
      } catch {
        continue;
      }
      for (const tree of trees)
        if (!inUse(tree.path)) found.push({ ...tree, project });
    }
    leftBehind.trees = found;
  } finally {
    leftBehind.loading = false;
  }
}

/** Removes the trees that can go of those given, one at a time, and reads
    what is left. A tree the core will not part with stays, and says why on
    the next read. */
export async function cleanWorktrees(trees: LeftTree[]): Promise<void> {
  for (const tree of removable(trees)) {
    try {
      await core().worktreeRemove(tree.project, tree.name, dirsOf());
      treeRemoved(tree.project, tree.path);
    } catch {
      // The tree grew work between the read and the removal. It stays.
    }
  }
  await readWorktrees();
}

/** Whether a live session is running in a directory. */
function inUse(path: string): boolean {
  return sessions.all.some(
    (session) =>
      isLive(session) &&
      (session.worktree === path || session.startIn === path),
  );
}

/**
 * The board, for any session that started others.
 *
 * The changes pane shows a session's started sessions in a section at its
 * foot, under the tree: each with its state, its step and round where it
 * runs for a workflow's step, and the controls to stop them, send them a
 * line, take back a project allowed and clean up worktrees left behind.
 */

/** The rows a session started, running or not, in the order they were
    started. */
export function startedRows(session: Session): Session[] {
  return tree.started.get(session.token) ?? [];
}

/** The session whose section stands at the changes pane's foot: the one
    on screen, while it has sessions it started, holds a standing answer to
    start more, or has worktrees its starts left behind, so what it was
    allowed can be taken back and what it left cleaned up once they are
    gone. */
export function boardOf(session: Session | null): Session | null {
  if (session === null) return null;
  if (
    startedRows(session).length > 0 ||
    allowedProjects(session.token).length > 0 ||
    treesFor(session).length > 0
  )
    return session;
  return null;
}

/** Whether the worktrees left behind are worth reading for a session: one
    of its starts made a worktree that may still be there. */
export function madeTrees(session: Session | null): boolean {
  return session !== null && treesMadeBy(session.token).length > 0;
}

/** A started row's dot, as the pane draws a plugin row's: hollow once the
    session no longer runs, the accent while it waits on you, breathing
    while it works. */
export function startedDot(session: Session): "none" | "waiting" | "busy" | "ok" {
  if (!isLive(session)) return "none";
  if (isAsking(session)) return "waiting";
  return conducting(session) ? "busy" : "ok";
}

/** What a started session is doing, in the words its rows elsewhere use. */
export function startedState(session: Session): string {
  return isAsking(session) ? "asking" : stateWord(session);
}

/** The line under a started session's name: its step and round where it
    runs for one, the project when it is not its starter's, the worktree
    when it runs in one, and what it is doing with how long since that
    last changed. */
export function startedDetail(starter: Session, session: Session, now = Date.now()): string {
  const parts: string[] = [];
  const at = placeTextOf(session.key);
  if (at !== null) parts.push(at.long);
  if (session.project !== starter.project) parts.push(projectLabel(session.project));
  const folder = session.worktree ?? session.startIn;
  if (folder !== null && folder !== session.project) parts.push(`worktree ${lastSegment(folder)}`);
  parts.push(`${startedState(session)}, ${since(lastChanged(session), now)}`);
  return parts.join(" · ");
}

/** How many characters of a session's name a row holds, as the dock cuts
    a name an agent chose. The row cuts it shorter to its width. */
export const NAME_SHOWN = 160;

/** A started session's name as the board shows it: cut to what a row
    holds, marked where it was cut. */
export function startedName(session: Session): string {
  const chars = Array.from(label(session));
  return chars.length > NAME_SHOWN ? `${chars.slice(0, NAME_SHOWN).join("")}…` : chars.join("");
}

/** The name on one line for a tooltip, with every character that would
    change how it reads without being seen written out. */
export function shownStarted(session: Session): string {
  return shown(startedName(session).replace(/\s+/g, " "));
}

/** The name the same way, in quotes, for a button's label. */
export function quotedStarted(session: Session): string {
  return `“${shownStarted(session)}”`;
}

/** Whether a line can be sent from the board: the session runs, with a
    terminal to type into or a conversation that takes a message. */
export function canSend(session: Session): boolean {
  if (session.status !== "running") return false;
  return session.kind === "integrated" ? handleOf(session.key) !== null : session.ptyId !== null;
}

/** Sends the user's line to a started session: typed into its terminal as
    the send tool types one, a line and nothing that drives the terminal,
    or for an integrated session as the user's own message. */
export function sendLine(session: Session, text: string): void {
  const line = oneLine(text);
  if (line === "" || !canSend(session)) return;
  if (session.kind === "integrated") sendIntegrated(session.key, line);
  else void typeLine(session.key, session.ptyId!, line);
}

/** The worktrees left behind that the session's own starts made. A tree
    is known by its project and its name, the folder the core made it in,
    which the core's listing and the start's answer both give. */
export function treesFor(session: Session): LeftTree[] {
  const made = treesMadeBy(session.token);
  return leftBehind.trees.filter((left) =>
    made.some((tree) => tree.project === left.project && lastSegment(tree.path) === left.name),
  );
}

/** The line about worktrees left behind: how many, and once they have
    been cleaned up, why the rest are still there. */
export function worktreeLine(trees: LeftTree[], cleaned: boolean): string {
  if (!cleaned) return `${trees.length} worktree${trees.length === 1 ? "" : "s"} left behind`;
  const dirty = trees.filter((left) => left.dirty).length;
  const ahead = trees.filter((left) => !left.dirty && !left.merged).length;
  const why = [
    dirty === 0 ? null : { count: dirty, said: "uncommitted work" },
    ahead === 0 ? null : { count: ahead, said: "has commits the project does not" },
  ].filter((part) => part !== null);
  if (why.length === 0) return `${trees.length} kept`;
  const said = why.length === 1 ? why[0].said : why.map((part) => `${part.count} ${part.said}`).join(", ");
  return `${trees.length} kept: ${said}`;
}

/** A question put before something is taken away, as the app asks one. */
export interface Question {
  question: string;
  detail: string;
  action: string;
}

/** Words for a count of sessions, "1 of them is" or "2 of them are". */
const ofThem = (count: number, all: number) =>
  all === 1 ? "It is" : `${count} of them ${count === 1 ? "is" : "are"}`;

/** What it is doing, as the question to stop it says it. */
function doingWords(rows: Session[], live: number): string[] {
  const working = rows.filter((row) => isLive(row) && row.working && !isAsking(row)).length;
  const asking = rows.filter(isAsking).length;
  const sentences: string[] = [];
  if (asking > 0) sentences.push(`${ofThem(asking, live)} waiting on you.`);
  if (working > 0) sentences.push(`${ofThem(working, live)} at work.`);
  return sentences;
}

/** What is asked before every session a session started is stopped: the
    ones still running are counted, and the rows of those that have ended
    go with them. */
export function stopAllQuestion(rows: Session[]): Question {
  const live = rows.filter(isLive).length;
  const ended = rows.length - live;
  const sentences = doingWords(rows, live);
  sentences.push(
    live === 1
      ? "Stopping it takes its row away; what it changed stays."
      : "Stopping them takes their rows away; what they changed stays.",
  );
  if (ended > 0) sentences.push(ended === 1 ? "The one that has ended goes too." : `The ${ended} that have ended go too.`);
  return {
    question:
      live === 1
        ? ended === 0
          ? "Stop the session it started?"
          : "Stop the session that still runs?"
        : `Stop all ${live} sessions it started?`,
    detail: sentences.join(" "),
    action: "Stop all",
  };
}

/** What is asked before one session it started is stopped from the
    keyboard, where a key is easier to press by mistake than a ×. */
export function stopOneQuestion(session: Session): Question {
  const live = isLive(session);
  const sentences = live ? doingWords([session], 1) : [];
  sentences.push(
    live ? "Stopping it takes its row away; what it changed stays." : "It has ended; its row goes, and what it changed stays.",
  );
  return {
    question: `${live ? "Stop" : "Close"} ${quotedStarted(session)}?`,
    detail: sentences.join(" "),
    action: live ? "Stop" : "Close",
  };
}

/** What is asked before the worktrees that can go are taken away, named
    one by one, with their branches. */
export function cleanQuestion(trees: LeftTree[]): Question {
  const going = removable(trees);
  const names = going.map((left) => shown(left.name));
  const staying = trees.length - going.length;
  const list =
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const one = going.length === 1;
  const detail = [
    `${list} ${one ? "goes, with its branch" : "go, with their branches"}: ${one ? "its" : "their"} work is merged and nothing in ${one ? "it" : "them"} is uncommitted.`,
    staying === 0 ? null : `${staying} ${staying === 1 ? "stays" : "stay"}, with work that is not merged or not committed.`,
  ];
  return {
    question: one ? "Clean up 1 worktree?" : `Clean up ${going.length} worktrees?`,
    detail: detail.filter((part) => part !== null).join(" "),
    action: "Clean up",
  };
}

// A session another started goes on after a usage limit as its starter's
// choice says.
parentsFrom(parentOf);
