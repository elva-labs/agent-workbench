/** The sentence every started session gets after the caller's own line, so
    what became of it comes back on its row instead of being watched for.
    It is the workbench's, never part of anyone's message as shown. */
export const OUTCOME_ASK =
  "When you are done, or stuck, call the notify tool with one line saying which, before your final message.";

/** A message's own words, and the workbench's sentence after them when it
    has one. */
export function spoken(text: string): { text: string; instructions: string | null } {
  if (text === OUTCOME_ASK) return { text: "", instructions: OUTCOME_ASK };
  if (text.endsWith(` ${OUTCOME_ASK}`))
    return { text: text.slice(0, -(OUTCOME_ASK.length + 1)), instructions: OUTCOME_ASK };
  return { text, instructions: null };
}
