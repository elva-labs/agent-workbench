/**
 * How long a tool call that waits on the user's answer is held before it
 * is answered that it waits on them.
 *
 * An agent gives up on a tool call of its own accord: Codex after a minute
 * unless the tool's server is given longer, and the tool server after its
 * own wait. An answer that comes after it gave up is never read, so a call
 * that may still go ahead once the user answers is answered before then,
 * saying that it waits on the user and how to hear how it went.
 */
export const HOLD = 40_000;
