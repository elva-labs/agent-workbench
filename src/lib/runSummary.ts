/**
 * Where a workflow's run stands, in words and pips, from what the conductor
 * keeps of it: the place of each session the orchestrator started, what
 * each of those is doing, the round question when one waits, the pieces
 * the user stopped at the limit, and whether the orchestrator itself is at
 * work.
 *
 * It says what is known and no more. The workbench never learns whether a
 * review passed, so a piece whose last review has finished is said to be
 * that: "Review, round 2 of 4 done", never done with the run.
 *
 * A round is one pass of work and review. A review counts its rounds per
 * piece of work; work sent back after a round goes on in the next one, so
 * it reads "Work, round 2 of 4". The limit counts the first pass: a review
 * that sends the work back three times at most has four rounds.
 *
 * Nothing here reads state of its own: what it is given is all it says.
 */

import type { ReviewStep, Workflow, WorkflowStep } from "$lib/core";

/** Where a started session stands in its starter's workflow, as the
    conductor keeps it. */
export interface RunPlace {
  step: string;
  kind: WorkflowStep["kind"];
  /** The piece of work it is part of, by the id of the work session that
      began it; null for the session that began it. */
  piece: string | null;
  /** The round it is in: a review's always, a work session's once its
      piece has been sent back. */
  round: number | null;
}

/** What a started session is doing, as the run tells it: at work, asking
    for a permission, done with its turn, stopped by a crash, or ended
    without the workbench having seen it come to rest. */
export type Doing = "working" | "asking" | "done" | "stopped" | "ended";

/** A session the orchestrator started for a step. */
export interface RunEntry {
  /** Its row, to open it; null once the row is gone. */
  key: string | null;
  id: string | null;
  /** The name the user knows it by. */
  name: string;
  place: RunPlace;
  doing: Doing;
}

/** A round past the review's limit, put to the user and not yet answered. */
export interface RunWait {
  step: string;
  /** The rounds the piece has had. */
  done: number;
  /** How many times the review may send the work back. */
  limit: number;
}

/** A piece the user stopped at the review's limit: "Stop at the limit"
    was the answer to another round, and no round of it has started since. */
export interface RunStop {
  /** The review, by name. */
  step: string;
  /** The piece, by the id of the work session that began it. */
  piece: string;
  /** The rounds it had when it was stopped. */
  round: number;
}

/** A step's pip: passed, where the run stands now, or to come. */
export type Pip = "done" | "live" | "todo";

/** One session in the popover's line for its step. */
export interface StepSession {
  key: string | null;
  name: string;
  /** Its round and what it is doing, as the popover says it: "round 2
      of 4, working". */
  words: string;
  /** Its round alone, "round 2 of 4", or null where it has none. */
  round: string | null;
  /** What it is doing, in words: its doing, or "stopped at the limit". */
  state: string;
  doing: Doing;
}

export interface StepStanding {
  name: string;
  pip: Pip;
  /** Passed with nothing run for it, as when the orchestrator did the
      step itself. Its pip is grey all the same. */
  skipped: boolean;
  /** The latest session of each piece in this step, in the order they
      were started. */
  sessions: StepSession[];
}

export interface RunSummary {
  /** The workflow's name, as the header names it. */
  workflow: string;
  steps: StepStanding[];
  /** What the chip says: the live step and its round, how many pieces
      stand in each step, the round that waits on the user, or where a
      piece was stopped or came to rest. */
  text: string;
  /** A round past the limit waits on the user. */
  waits: boolean;
  /** Every piece has finished a round of the last step, its session seen
      to come to rest there, and nothing is at work, the orchestrator
      included: every pip is grey. Whether the last review passed is not
      known. */
  through: boolean;
  /** Nothing has been started for a step yet. */
  begun: boolean;
  /** The whole state in words, for a screen reader. */
  spoken: string;
}

/** Names the same when they differ only in the case of A to Z, as the
    workflows compare them. */
const sameName = (a: string, b: string) =>
  a.trim().replace(/[A-Z]/g, (c) => c.toLowerCase()) === b.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The review that counts a step's rounds: the step itself for a review,
    and for a work step the review that sends work back to it. */
function reviewOf(workflow: Workflow, step: WorkflowStep): ReviewStep | null {
  if (step.kind === "review") return step;
  return (
    workflow.steps.find(
      (candidate): candidate is ReviewStep => candidate.kind === "review" && sameName(candidate.backTo, step.name),
    ) ?? null
  );
}

/** A place's round and the most there are, as far as they are worth
    saying: a review's always, a work session's from its second round. */
export interface PlaceWords {
  step: string;
  round: number | null;
  of: number | null;
}

export function placeWords(workflow: Workflow | null, place: RunPlace): PlaceWords {
  const step = workflow?.steps.find((candidate) => sameName(candidate.name, place.step));
  const review = workflow === null || step === undefined ? null : reviewOf(workflow, step);
  const name = step?.name ?? place.step;
  const of = review === null ? null : review.limit + 1;
  if (place.kind === "review") return { step: name, round: place.round ?? 1, of };
  if (review === null || place.round === null || place.round < 2) return { step: name, round: null, of: null };
  return { step: name, round: place.round, of };
}

/** "round 2 of 4", or null where there is no round to say. */
export function roundText(words: PlaceWords): string | null {
  if (words.round === null) return null;
  return words.of === null ? `round ${words.round}` : `round ${words.round} of ${words.of}`;
}

/** "Review, round 2 of 4", or the step alone. */
export function placeLong(words: PlaceWords): string {
  const round = roundText(words);
  return round === null ? words.step : `${words.step}, ${round}`;
}

/** The rail's short form: "Review, 2 of 4". */
export function placeShort(words: PlaceWords): string {
  if (words.round === null) return words.step;
  return words.of === null ? `${words.step}, ${words.round}` : `${words.step}, ${words.round} of ${words.of}`;
}

const active = (doing: Doing) => doing === "working" || doing === "asking";

/** A session's step, by its index in the workflow, and its round, which
    orders a piece's sessions: a later round first, then a later step. */
interface Ranked {
  entry: RunEntry;
  index: number;
  round: number;
}

const later = (a: Ranked, b: Ranked) => (a.round !== b.round ? a.round > b.round : a.index > b.index);

function latest(items: Ranked[]): Ranked {
  return items.reduce((best, item) => (later(item, best) ? item : best));
}

const PIP_WORDS: Record<Pip, string> = { done: "done", live: "now", todo: "to come" };

/** What the summary is made from. */
export interface RunInput {
  workflow: Workflow;
  entries: RunEntry[];
  /** The round question, while it waits on the user. */
  wait: RunWait | null;
  stops: RunStop[];
  /** Whether the orchestrator itself is at work. */
  directing: boolean;
  /** The workflow's name as the header says it; its own when left out. */
  name?: string;
}

/**
 * Where the run stands. Each piece of work stands in one step: where a
 * session of it is at work, or else where its latest session came to rest.
 *
 * With pieces at work the chip names their steps. With none, it names the
 * steps the pieces rest in, leaving out a piece that never reached the
 * work a review checks, such as a plan the orchestrator did not carry on,
 * once another piece has. A piece the user stopped at the limit says so.
 * Once every piece has finished a round of the last step, its session done
 * with its turn rather than crashed or ended unseen, and the orchestrator
 * rests too, every pip is grey and the words say the round that finished,
 * since whether it passed is not known.
 */
export function summarize(input: RunInput): RunSummary {
  const { workflow, entries, wait, stops, directing } = input;
  const name = input.name ?? workflow.name;
  const last = workflow.steps.length - 1;
  const indexOf = (step: string) => workflow.steps.findIndex((candidate) => sameName(candidate.name, step));
  const ranked: Ranked[] = entries
    .map((entry) => ({ entry, index: indexOf(entry.place.step), round: entry.place.round ?? 1 }))
    .filter((item) => item.index >= 0);

  const pieces = new Map<string, Ranked[]>();
  for (const item of ranked) {
    const { place, id, key, name: called } = item.entry;
    const piece = place.piece ?? id ?? key ?? called;
    pieces.set(piece, [...(pieces.get(piece) ?? []), item]);
  }

  /** Where the work a review checks begins: the first step a review sends
      work back to, or the review itself. With no review, the last step. */
  const reviews = workflow.steps.flatMap((step, index) => {
    if (step.kind !== "review") return [];
    const back = indexOf(step.backTo);
    return [back >= 0 ? Math.min(back, index) : index];
  });
  const checked = reviews.length > 0 ? Math.min(...reviews) : last;

  /** Where each piece stands, whether something of it is at work, and
      whether the user stopped it at the limit. */
  const standing = [...pieces.entries()].map(([piece, items]) => {
    const working = items.filter((item) => active(item.entry.doing));
    const at = working.length > 0 ? latest(working) : latest(items);
    const stop =
      working.length > 0
        ? null
        : (stops.find((candidate) => candidate.piece === piece && sameName(candidate.step, at.entry.place.step)) ?? null);
    return {
      at,
      working: working.length > 0,
      stop,
      reached: Math.max(...items.map((item) => item.index)) >= checked,
    };
  });

  const working = standing.filter((piece) => piece.working);
  const resting = standing.filter((piece) => !piece.working);
  const counted = resting.some((piece) => piece.reached) ? resting.filter((piece) => piece.reached) : resting;
  const begun = ranked.length > 0;
  const through =
    begun &&
    wait === null &&
    working.length === 0 &&
    !directing &&
    counted.length > 0 &&
    counted.every((piece) => piece.stop === null && piece.at.index === last && piece.at.entry.doing === "done");
  const shown = working.length > 0 ? working : counted;

  const waitAt = wait === null ? -1 : indexOf(wait.step);
  const live = new Set<number>(
    through
      ? []
      : wait !== null
        ? [...(waitAt >= 0 ? [waitAt] : []), ...working.map((piece) => piece.at.index)]
        : shown.map((piece) => piece.at.index),
  );
  const reach = Math.max(-1, ...live);
  const pipOf = (index: number): Pip =>
    !begun ? "todo" : through ? "done" : live.has(index) ? "live" : index < reach ? "done" : "todo";

  /** Of the review a stopped piece stands in, the most rounds there are. */
  const ofStop = (stop: RunStop) => {
    const review = workflow.steps.find((step) => sameName(step.name, stop.step));
    return review?.kind === "review" ? ` of ${review.limit + 1}` : "";
  };
  const counts = (items: typeof shown) => {
    const tally = new Map<number, number>();
    for (const piece of items) tally.set(piece.at.index, (tally.get(piece.at.index) ?? 0) + 1);
    return [...tally.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, count]) => `${count} in ${workflow.steps[index].name}`)
      .join(", ");
  };

  let text: string;
  if (wait !== null) text = `Round ${wait.done} of ${wait.limit + 1} done, asks you`;
  else if (!begun) text = name;
  else if (through)
    text =
      counted.length === 1
        ? `${placeLong(placeWords(workflow, counted[0].at.entry.place))} done`
        : `${counted.length} done in ${workflow.steps[last].name}`;
  else if (shown.length === 1 && shown[0].stop !== null)
    text = `Stopped at round ${shown[0].stop.round}${ofStop(shown[0].stop)}`;
  else if (shown.length === 1) text = placeLong(placeWords(workflow, shown[0].at.entry.place));
  else text = counts(shown);

  const stoppedAt = new Set(standing.flatMap((piece) => (piece.stop === null ? [] : [piece.at])));
  const steps: StepStanding[] = workflow.steps.map((step, index) => {
    const here = [...pieces.values()]
      .map((items) => items.filter((item) => item.index === index))
      .filter((items) => items.length > 0)
      .map(latest);
    const order = (item: Ranked) => ranked.indexOf(item);
    const pip = pipOf(index);
    return {
      name: step.name,
      pip,
      skipped: pip === "done" && here.length === 0,
      sessions: here
        .sort((a, b) => order(a) - order(b))
        .map((item) => {
          const { entry } = item;
          const round = roundText(placeWords(workflow, entry.place));
          const state = stoppedAt.has(item) ? "stopped at the limit" : entry.doing;
          return {
            key: entry.key,
            name: entry.name,
            words: round === null ? state : `${round}, ${state}`,
            round,
            state,
            doing: entry.doing,
          };
        }),
    };
  });

  const said = (step: StepStanding) => (step.skipped ? "skipped" : PIP_WORDS[step.pip]);
  const spoken = `${name}: ${text}. ${steps.map((step) => `${step.name} ${said(step)}`).join(", ")}.`;
  return { workflow: name, steps, text, waits: wait !== null, through, begun, spoken };
}
