/**
 * What ended a turn the agent did not finish itself: a usage limit, with
 * when it lifts where the agent says, or another error from the model's
 * service, such as a connection lost mid-response.
 *
 * The agent says so in one of two ways. Claude Code's hook for a failed
 * turn names the error's kind and the line it showed; without that hook,
 * the line is on its screen, under the turn's last bullet or in the footer
 * it draws while a limit holds.
 */

export interface Failure {
  /** The agent is at a usage limit, not on another error. */
  limit: boolean;
  /** When the limit lifts, in the agent's words, where it says and the
      words are plainly a time. */
  until: string | null;
  /** The line the agent showed for it, as it showed it. */
  line: string | null;
}

/** A line that says a usage limit holds. */
const LIMIT =
  /\b(?:usage|session|weekly|daily|monthly|spend|\d+-hour)\s+limit\b|\bhit your\b.*\blimit\b|\blimit reached\b|\bout of usage\b/i;
/** A line that says an error ended the response. */
const ERROR = /\bAPI Error\b|\bConnection lost\b|\bwent to sleep mid-response\b|\bresponse (?:stalled|stopped arriving)\b/i;
/** When a limit lifts: the words after "resets", up to a bracket or a
    middle dot. */
const RESETS = /\bresets?\s+(?:at\s+|on\s+)?([^·()\n]+?)\s*(?:[(·]|$)/i;
/** What a time may be made of: letters, digits, spaces and the marks a
    time or a date uses, and no more than a time takes. */
const PLAIN_TIME = /^[\p{L}\p{N} :.,+\-/]{1,24}$/u;
/** The most words a time or a date with it takes, "Thu Nov 18 2pm". */
const TIME_WORDS = 4;

/** When a limit lifts, as the line says it, where it says it plainly: a
    few words with a number in them, and nothing else. */
export function resetsAt(line: string): string | null {
  const found = RESETS.exec(line.normalize("NFKC"));
  if (found === null) return null;
  const until = found[1].trim().replace(/[.,]+$/, "");
  return PLAIN_TIME.test(until) && /\d/.test(until) && until.split(/\s+/).length <= TIME_WORDS
    ? until
    : null;
}

/** A failed turn as the agent reported it: the kind of error its hook
    named, if any, and the line it showed. */
export function failureOf(error: string | null, line: string | null): Failure {
  const limit = error === "rate_limit" || (line !== null && LIMIT.test(line));
  return { limit, until: limit && line !== null ? resetsAt(line) : null, line };
}

/** The bullets Claude Code draws before what a turn says or does. */
const BULLET = /^\s*[⏺●]/;

/**
 * What the last lines of a session's screen say ended its turn, read from
 * the turn's last bullet down: a usage limit or an error, or null when
 * they say neither. A line from an earlier turn, above a later bullet, is
 * not read.
 */
export function failureOnScreen(lines: string[]): Failure | null {
  let from = 0;
  for (let at = lines.length - 1; at >= 0; at--)
    if (BULLET.test(lines[at])) {
      from = at;
      break;
    }
  const tail = lines.slice(from).map((line) => line.replace(/^[\s⏺●⎿⚠│]+/u, "").trim());
  // The status line's own reset, of a limit not yet reached, is not when
  // this one lifts: only lines that say a limit holds are read for it.
  const limits = tail.filter((line) => LIMIT.test(line));
  if (limits.length > 0) {
    const until = limits.map(resetsAt).find((at) => at !== null) ?? null;
    return { limit: true, until, line: limits[0] };
  }
  const error = tail.find((line) => ERROR.test(line));
  return error === undefined ? null : { limit: false, until: null, line: error };
}
