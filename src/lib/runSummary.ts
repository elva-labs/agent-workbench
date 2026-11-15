/**
 * Where a workflow's run stands, in words and pips, from what the conductor
 * keeps of it: the place of each session the orchestrator started, what
 * each of those is doing, the round question when one waits, and whether
 * the orchestrator itself is at work.
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

/** What a started session is doing, as the run tells it. */
export type Doing = "working" | "asking" | "done" | "stopped";

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

/** A step's pip: done, where the run stands now, or to come. */
export type Pip = "done" | "live" | "todo";

/** One session in the popover's line for its step. */
export interface StepSession {
  key: string | null;
  name: string;
  /** Its round and what it is doing: "round 2 of 4, working". */
  words: string;
  doing: Doing;
}

export interface StepStanding {
  name: string;
  pip: Pip;
  /** The latest session of each piece in this step, in the order they
      were started. */
  sessions: StepSession[];
}

export interface RunSummary {
  /** The workflow's name, as the header names it. */
  workflow: string;
  steps: StepStanding[];
  /** What the chip says: the live step and its round, how many pieces
      stand in each step, Done, or the round that waits on the user. */
  text: string;
  /** A round past the limit waits on the user. */
  waits: boolean;
  /** Every piece has come through the last step and nothing is at work. */
  done: boolean;
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

/**
 * Where the run stands. Each piece of work stands in one step: where a
 * session of it is at work, or else where its latest session came to rest.
 * The chip names the steps that pieces at work stand in; with none at
 * work, the furthest step a piece rests in. The steps before the furthest
 * of those are done, and the run is done once the pieces rest past the
 * last step with the orchestrator at rest too.
 */
export function summarize(
  workflow: Workflow,
  entries: RunEntry[],
  wait: RunWait | null,
  directing: boolean,
  name: string = workflow.name,
): RunSummary {
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

  /** Where each piece stands, and whether something of it is at work. */
  const standing = [...pieces.values()].map((items) => {
    const working = items.filter((item) => active(item.entry.doing));
    return working.length > 0 ? { at: latest(working), working: true } : { at: latest(items), working: false };
  });

  const working = standing.filter((piece) => piece.working);
  const furthest = Math.max(-1, ...standing.map((piece) => piece.at.index));
  const shown = working.length > 0 ? working : standing.filter((piece) => piece.at.index === furthest);
  const begun = ranked.length > 0;
  const waitAt = wait === null ? -1 : indexOf(wait.step);
  const done = begun && wait === null && working.length === 0 && !directing && furthest === workflow.steps.length - 1;

  const live = new Set<number>(waitAt >= 0 ? [waitAt] : shown.map((piece) => piece.at.index));
  const reach = Math.max(-1, ...live);
  const pipOf = (index: number): Pip =>
    !begun ? "todo" : done ? "done" : live.has(index) ? "live" : index < reach ? "done" : "todo";

  let text: string;
  if (wait !== null) text = `Round ${wait.done} of ${wait.limit + 1} done, asks you`;
  else if (!begun) text = name;
  else if (done) text = "Done";
  else if (shown.length === 1) text = placeLong(placeWords(workflow, shown[0].at.entry.place));
  else {
    const counts = new Map<number, number>();
    for (const piece of shown) counts.set(piece.at.index, (counts.get(piece.at.index) ?? 0) + 1);
    text = [...counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, count]) => `${count} in ${workflow.steps[index].name}`)
      .join(", ");
  }

  const steps: StepStanding[] = workflow.steps.map((step, index) => {
    const here = [...pieces.values()]
      .map((items) => items.filter((item) => item.index === index))
      .filter((items) => items.length > 0)
      .map(latest);
    const order = (item: Ranked) => ranked.indexOf(item);
    return {
      name: step.name,
      pip: pipOf(index),
      sessions: here
        .sort((a, b) => order(a) - order(b))
        .map(({ entry }) => {
          const round = roundText(placeWords(workflow, entry.place));
          return {
            key: entry.key,
            name: entry.name,
            words: round === null ? entry.doing : `${round}, ${entry.doing}`,
            doing: entry.doing,
          };
        }),
    };
  });

  const spoken = `${name}: ${text}. ${steps.map((step) => `${step.name} ${PIP_WORDS[step.pip]}`).join(", ")}.`;
  return { workflow: name, steps, text, waits: wait !== null, done, begun, spoken };
}
