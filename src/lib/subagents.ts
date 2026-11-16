import type { Conversation, Task, ToolCall } from "$lib/conversation.svelte";
import { callInput } from "$lib/thread";
import { shown } from "$lib/unseen";

/**
 * The subagents a session has out, as the sessions rail hangs them under
 * it, worked out from its conversation and nothing else: each call that
 * started a subagent, with what it was asked to do, its kind, where it
 * stands and when that last changed.
 *
 * One shows while it runs or asks. Once done it stays, greyed, while the
 * session is still at work and no turn has ended since it finished, so the
 * subagents of one piece of work go together once the turn that waits on
 * them is over. A subagent that runs in the background outlives the turn
 * that started it and is followed by its task until it ends.
 *
 * What it was asked and its kind are the agent's own words: they are cut
 * here to what a row can hold, and drawn as text with every unseen
 * character shown.
 */

export type SubagentState = "running" | "asking" | "done" | "failed" | "stopped";

export interface Subagent {
  /** The call that started it: the row's key, and where the session
      opens to it. */
  call: string;
  /** What it was asked to do, in the agent's words, cut; null until the
      call's input says. */
  about: string | null;
  /** Its kind as the agent named it, Explore, Plan or general, cut; null
      until the call's input says. */
  kind: string | null;
  state: SubagentState;
  /** When it came to the state it is in. */
  at: number;
}

/** How many characters of what a subagent was asked a row keeps. */
export const ABOUT_MOST = 80;
/** How many characters of its kind. */
export const KIND_MOST = 20;

/** Text cut to `most` characters, marked where it was cut. */
function cut(text: string, most: number): string {
  const chars = Array.from(text);
  return chars.length > most ? `${chars.slice(0, most - 1).join("")}…` : text;
}

function field(input: unknown, name: string): string | null {
  if (input === null || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The first line of a prompt with something on it. */
function firstLine(text: string | null): string | null {
  if (text === null) return null;
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? null;
}

/** What a call asked its subagent to do, and the subagent's kind. */
export function asked(call: ToolCall): { about: string | null; kind: string | null } {
  const input = callInput(call);
  const about = field(input, "description") ?? firstLine(field(input, "prompt"));
  const type = field(input, "subagent_type");
  const kind = type === "general-purpose" ? "general" : type;
  return {
    about: about === null ? null : cut(about.trim(), ABOUT_MOST),
    kind: kind === null ? null : cut(kind.trim(), KIND_MOST),
  };
}

/** The tasks a call started that are its subagent's run. */
function runsOf(call: ToolCall): Task[] {
  return call.tasks.filter((task) => task.kind === "agent" && !task.ambient);
}

/** The call in the main conversation a call belongs to: itself, or the
    call that started the subagent it was made in. */
function topOf(conversation: Conversation, id: string | null): ToolCall | null {
  let call = id === null ? null : conversation.call(id);
  for (let depth = 0; call !== null && call.parent !== null && depth < 8; depth++) {
    const up = conversation.call(call.parent);
    if (up === null) break;
    call = up;
  }
  return call;
}

/** The subagents a session's rows show, in the order they started. */
export function subagentsOf(conversation: Conversation): Subagent[] {
  const ended = conversation.turnEnded ?? Number.NEGATIVE_INFINITY;
  const calls = new Map<string, ToolCall>();
  const take = (call: ToolCall | null) => {
    if (call !== null && call.tool === "agent" && call.parent === null) calls.set(call.call, call);
  };

  // The running turn's calls: a subagent its turn waits on can only be in
  // the turn that runs.
  if (conversation.current !== null) {
    const entries = conversation.entries;
    for (let at = entries.length - 1; at >= 0; at--) {
      const entry = entries[at];
      if (entry.kind !== "agent") continue;
      if (entry.turn !== conversation.current) {
        const turn = conversation.turns[entry.turn];
        if (turn?.endedAt !== null && turn?.endedAt !== undefined && turn.endedAt <= ended) break;
        continue;
      }
      for (const part of entry.parts) if (part.kind === "tool") take(part);
    }
  }
  // Those still at work in the background, or finished since a turn last
  // ended.
  for (const task of conversation.tasks) {
    if (task.kind !== "agent" || task.ambient || task.call === null) continue;
    if (task.status === "running" || task.until > ended) take(conversation.call(task.call));
  }
  // Those that ask: from inside the subagent, or to start it.
  const asking = new Map<string, number>();
  for (const request of conversation.open) {
    const owner = request.asked.parent !== null ? topOf(conversation, request.asked.parent) : conversation.call(request.asked.call ?? "");
    if (owner === null || owner.tool !== "agent" || owner.parent !== null) continue;
    take(owner);
    if (!asking.has(owner.call)) asking.set(owner.call, request.at ?? owner.at);
  }

  const out: Subagent[] = [];
  for (const call of calls.values()) {
    const runs = runsOf(call);
    const { about, kind } = asked(call);
    const askedAt = asking.get(call.call);
    if (askedAt !== undefined) {
      out.push({ call: call.call, about, kind, state: "asking", at: askedAt });
      continue;
    }
    // A call that has yet to hand back what its subagent said runs on,
    // and so does a subagent in the background after its call returned.
    const running = runs.find((run) => run.status === "running");
    if (running !== undefined || !call.done) {
      out.push({ call: call.call, about, kind, state: "running", at: running?.at ?? call.at });
      continue;
    }
    const finished = Math.max(call.until, ...runs.map((run) => run.until));
    if (!conversation.working || finished <= ended) continue;
    const state: SubagentState = runs.some((run) => run.status === "failed" || run.status === "lost")
      ? "failed"
      : runs.some((run) => run.status === "stopped")
        ? "stopped"
        : runs.length === 0 && call.error
          ? "failed"
          : "done";
    out.push({ call: call.call, about, kind, state, at: finished });
  }
  return out.sort((a, b) => calls.get(a.call)!.at - calls.get(b.call)!.at);
}

/** What a session's subagents are doing, in words, each counted once:
    "2 subagents running, 1 asking". */
export function subagentWords(subagents: Subagent[]): string {
  const running = subagents.filter((one) => one.state === "running").length;
  const asking = subagents.filter((one) => one.state === "asking").length;
  const done = subagents.length - running - asking;
  const parts: [number, string][] = (
    [
      [running, "running"],
      [asking, "asking"],
      [done, "done"],
    ] as [number, string][]
  ).filter(([count]) => count > 0);
  return parts
    .map(([count, word], at) => (at === 0 ? `${count} ${count === 1 ? "subagent" : "subagents"} ${word}` : `${count} ${word}`))
    .join(", ");
}

/** A subagent's state as a row says it: its kind while it runs, else the
    state in a word. */
export function subagentNote(subagent: Subagent): string | null {
  switch (subagent.state) {
    case "running":
      return subagent.kind;
    case "asking":
      return "asking";
    default:
      return subagent.state;
  }
}

/** What a subagent's row says to a screen reader, what cannot be seen in
    the agent's words written out. */
export function subagentSaid(subagent: Subagent): string {
  const what = subagent.about === null ? "A subagent" : `Subagent for ${shown(subagent.about)}`;
  const state =
    subagent.state === "asking" ? "asking for a permission" : subagent.state === "running" ? "running" : subagent.state;
  return subagent.kind === null ? `${what}, ${state}` : `${what}, ${shown(subagent.kind)}, ${state}`;
}
