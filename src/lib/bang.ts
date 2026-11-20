/**
 * A line the user runs in the shell of the session's folder: a message
 * that begins with `!`, and a command the agent writes for the user to
 * run, a code span or a line of a code block that begins with `!` and a
 * space.
 */

/** The command a message runs, when it begins with `!`: what follows the
    `!`, trimmed, empty while nothing does. Null for a message that does
    not begin with `!`, which is a message to the agent. */
export function bangLine(draft: string): string | null {
  if (!draft.startsWith("!")) return null;
  return draft.slice(1).trim();
}

/** A character that changes how text is drawn, or is not drawn at all: a
    control or format character other than a tab, such as a bidirectional
    override or a zero-width space, a line or paragraph separator, and any
    other character Unicode leaves undrawn, such as a Hangul filler. */
const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** The command in a code span or in a line of a code block the agent
    wrote: one that begins with `!` and a space, then the command. Null for
    anything else, a `!` with no space after it as in `!important` among
    them, and a command holding a character that could make it read as
    other than what runs. */
export function runnable(code: string): string | null {
  if (!code.startsWith("! ")) return null;
  const command = code.slice(2).trim();
  if (command === "" || hidden.test(command.replaceAll("\t", ""))) return null;
  return command;
}
