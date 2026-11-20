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

/** The command in a code span or in a line of a code block the agent
    wrote: one that begins with `!` and a space, then the command. Null for
    anything else, a `!` with no space after it as in `!important` among
    them. */
export function runnable(code: string): string | null {
  if (!code.startsWith("! ")) return null;
  const command = code.slice(2).trim();
  return command === "" || command.includes("\n") ? null : command;
}
