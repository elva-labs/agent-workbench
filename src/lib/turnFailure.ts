/**
 * What ended a turn the agent did not finish itself: a usage limit, with
 * when it lifts where the agent says, or another error from the model's
 * service, such as a connection lost mid-response.
 *
 * The agent says so in one of two ways. Claude Code's hook for a failed
 * turn names the error's kind and the line it showed; without that hook,
 * the line is on its screen, as the result line Claude Code draws under the
 * turn's last bullet or in the footer it draws while a limit holds. Only
 * lines of Claude Code's own shape count: what the agent writes about a
 * limit or an error, in its answer or in a tool's output, is not one.
 */

export interface Failure {
  /** The agent is at a usage limit, not on another error. */
  limit: boolean;
  /** When the limit lifts, in the agent's words, where it says and the
      words are a time or a date as Claude Code writes them. */
  until: string | null;
  /** The line the agent showed for it, as it showed it. */
  line: string | null;
}

/** A line Claude Code draws when a usage limit ends a turn, read from its
    start. */
const LIMIT = /^(?:You've (?:hit|reached) your\b.*\blimit\b|Usage limit reached\b|You're out of usage\b)/i;
/** A line Claude Code draws when an error from the model's service ends a
    turn, read from its start. */
const ERROR = /^API Error\b/;
/** When a limit lifts: the words after "resets", up to a bracket or a
    middle dot. */
const RESETS = /\bresets?\s+(?:(?:at|on|in)\s+)?([^·()\n]+?)\s*(?:[(·]|$)/i;

const WEEKDAY =
  "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow)";
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "\\d{1,2}(?:st|nd|rd|th)?";
const DATE = `(?:${MONTH}\\s+${DAY}|${DAY}\\s+${MONTH})`;
const TIME = "(?:\\d{1,2}(?::\\d{2})?\\s?(?:am|pm)|\\d{1,2}:\\d{2})";
/** A time a limit lifts at, as Claude Code writes one: a time of day, with
    a day or a date before it, or a date alone. Nothing else is taken, so
    no words but these reach another agent as the workbench's own. */
const WHEN = new RegExp(
  `^(?:(?:${WEEKDAY},?\\s+)?(?:${DATE},?\\s+)?(?:at\\s+)?${TIME}|(?:${WEEKDAY},?\\s+)?${DATE})$`,
  "i",
);

/** When a limit lifts, as the line says it, where it says it as a time or
    a date. A span such as "in 3h" is no time. */
export function resetsAt(line: string): string | null {
  const found = RESETS.exec(line.normalize("NFKC"));
  if (found === null) return null;
  const until = found[1].trim().replace(/[.,]+$/, "");
  return WHEN.test(until) ? until : null;
}

/** A failed turn as the agent reported it: the kind of error its hook
    named, if any, and the line it showed. */
export function failureOf(error: string | null, line: string | null): Failure {
  const limit = error === "rate_limit" || (line !== null && LIMIT.test(line.trim()));
  return { limit, until: limit && line !== null ? resetsAt(line) : null, line };
}

/** The bullets Claude Code draws before what a turn says or does. */
const BULLET = /^\s*[⏺●]/;
/** The mark before a result line, and the one before the footer's notice. */
const RESULT = /^\s*⎿\s*/;
const NOTICE = /^\s*⚠\s*/;

/**
 * What the last lines of a session's screen say ended its turn, read from
 * the turn's last bullet down: a usage limit or an error, or null when
 * they say neither. Only the last result line and the footer's notices are
 * read, and only where they begin as Claude Code's own do. A line from an
 * earlier turn, above a later bullet, is not read, nor anything the agent
 * said under a bullet.
 */
export function failureOnScreen(lines: string[]): Failure | null {
  let from = 0;
  for (let at = lines.length - 1; at >= 0; at--)
    if (BULLET.test(lines[at])) {
      from = at;
      break;
    }
  const tail = lines.slice(from);
  const results = tail.filter((line) => RESULT.test(line));
  const last = results.length === 0 ? [] : [results[results.length - 1].replace(RESULT, "").trim()];
  const notices = tail.filter((line) => NOTICE.test(line)).map((line) => line.replace(NOTICE, "").trim());
  const said = [...last, ...notices];
  const limits = said.filter((line) => LIMIT.test(line));
  if (limits.length > 0) {
    const until = limits.map(resetsAt).find((at) => at !== null) ?? null;
    return { limit: true, until, line: limits[0] };
  }
  const error = last.find((line) => ERROR.test(line));
  return error === undefined ? null : { limit: false, until: null, line: error };
}

/** The line Claude Code draws under a turn the user stopped, a tool call
    refused at its permission prompt among them: "Interrupted · What should
    Claude do instead?". */
const INTERRUPTED = /^Interrupted\b/;

/** Whether the last lines of a session's screen show the turn stopped by
    the user, on a result line under the turn's last bullet. */
export function interruptedOnScreen(lines: string[]): boolean {
  let from = 0;
  for (let at = lines.length - 1; at >= 0; at--)
    if (BULLET.test(lines[at])) {
      from = at;
      break;
    }
  return lines
    .slice(from)
    .some((line) => RESULT.test(line) && INTERRUPTED.test(line.replace(RESULT, "").trim()));
}
