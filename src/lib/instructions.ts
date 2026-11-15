/** The sentence every started session gets after the caller's own line, so
    what became of it comes back on its row instead of being watched for.
    It is the workbench's, never part of anyone's message as shown. */
export const OUTCOME_ASK =
  "When you are done, or stuck, call the notify tool with one line saying which, before your final message.";

/** The first line of the note a session that started others is given ahead
    of the user's words, on what those sessions did since it last looked.
    The note is the workbench's, a line each, and a blank line ends it. */
export const REPORTS_HEAD = "From the workbench, not the user, on the sessions you started:";

/** A message's own words, the workbench's sentence after them when it has
    one, and the workbench's note on the sessions it started ahead of them
    when it has one, without its first line. */
export function spoken(text: string): {
  text: string;
  instructions: string | null;
  reports: string | null;
} {
  let words = text;
  let reports: string | null = null;
  if (words.startsWith(`${REPORTS_HEAD}\n`)) {
    const end = words.indexOf("\n\n");
    reports = (end === -1 ? words : words.slice(0, end)).slice(REPORTS_HEAD.length + 1);
    words = end === -1 ? "" : words.slice(end + 2);
  }
  if (words === OUTCOME_ASK) return { text: "", instructions: OUTCOME_ASK, reports };
  if (words.endsWith(` ${OUTCOME_ASK}`))
    return { text: words.slice(0, -(OUTCOME_ASK.length + 1)), instructions: OUTCOME_ASK, reports };
  return { text: words, instructions: null, reports };
}
