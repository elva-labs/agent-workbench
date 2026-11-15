import type { IntegratedCommand } from "$lib/core";
import { rank, type Match } from "$lib/completion";

/**
 * The slash commands and skills an integrated session's agent takes at the
 * start of a message: when a message is one being typed, which of them it
 * leaves, what completing one writes, and which one a message names.
 *
 * Only a slash typed as the very first thing in a message starts one;
 * anywhere else a slash is text. The word runs to the first space.
 */

/** A slash word being typed: what follows the slash up to the caret, and
    where the word ends. */
export interface SlashWord {
  query: string;
  end: number;
}

/** The slash word the caret is in, or null when the message does not begin
    with a slash or the caret is past its first word. */
export function slashWord(draft: string, caret: number): SlashWord | null {
  if (!draft.startsWith("/")) return null;
  const space = draft.search(/\s/);
  const end = space === -1 ? draft.length : space;
  if (caret < 1 || caret > end) return null;
  return { query: draft.slice(1, caret), end };
}

export interface SlashGroup {
  label: "Commands" | "Skills";
  matches: Match<IntegratedCommand>[];
}

/** The commands, then the skills, that a query leaves, each best first,
    and of two as good the agent's own first. A group with nothing in it is
    left out. */
export function slashGroups(commands: readonly IntegratedCommand[], query: string): SlashGroup[] {
  const of = (skill: boolean) =>
    rank(
      commands.filter((command) => command.skill === skill),
      nameOf,
      query,
      (a, b) => Number(b.builtin) - Number(a.builtin),
    );
  const groups: SlashGroup[] = [
    { label: "Commands", matches: of(false) },
    { label: "Skills", matches: of(true) },
  ];
  return groups.filter((group) => group.matches.length > 0);
}

function nameOf(command: IntegratedCommand): string {
  return command.name;
}

/** The message with its slash word made the command's name and a space,
    and where the caret goes: after the space. */
export function complete(draft: string, word: SlashWord, name: string): { text: string; caret: number } {
  const rest = draft.slice(word.end).replace(/^[ \t]/, "");
  const head = `/${name} `;
  return { text: `${head}${rest}`, caret: head.length };
}

/** The command a message begins with, its slash first of all, and the
    words after it, when the agent takes one by that name. */
export function named(
  draft: string,
  commands: readonly IntegratedCommand[],
): { command: IntegratedCommand; rest: string } | null {
  const found = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trimEnd());
  if (found === null) return null;
  const command = commands.find((known) => known.name === found[1]);
  return command === undefined ? null : { command, rest: (found[2] ?? "").trim() };
}

/** The argument hint to show after a command just completed: while the
    message is the command and a space, with nothing typed after it. */
export function waitingHint(draft: string, commands: readonly IntegratedCommand[]): string | null {
  const found = /^\/(\S+) $/.exec(draft);
  if (found === null) return null;
  return commands.find((known) => known.name === found[1])?.hint ?? null;
}

/** Where a command comes from, as the menu says it. */
export function sourceOf(command: IntegratedCommand): string {
  return command.builtin ? "built in" : (command.source ?? "");
}
