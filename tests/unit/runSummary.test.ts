import { describe, expect, it } from "vitest";
import type { Workflow } from "$lib/core";
import {
  placeLong,
  placeShort,
  placeWords,
  roundText,
  summarize,
  type Doing,
  type RunEntry,
  type RunPlace,
} from "$lib/runSummary";

/** Plan, then Work, then a Review that sends the work back to Work three
    times at most: four rounds. */
const FLOW: Workflow = {
  name: "Plan, work, review",
  orchestrator: { agent: "claude-code", model: "fable" },
  steps: [
    { kind: "work", name: "Plan", models: [], parallel: 1 },
    { kind: "work", name: "Work", models: [], parallel: 2 },
    {
      kind: "review",
      name: "Review",
      models: [],
      reviewerApproves: true,
      orchestratorAgrees: true,
      backTo: "Work",
      limit: 3,
    },
  ],
};

const work = (piece: string | null, round: number | null = null): RunPlace => ({
  step: "Work",
  kind: "work",
  piece,
  round,
});
const review = (piece: string, round: number): RunPlace => ({ step: "Review", kind: "review", piece, round });
const plan: RunPlace = { step: "Plan", kind: "work", piece: null, round: null };

const entry = (id: string, name: string, place: RunPlace, doing: Doing): RunEntry => ({
  key: `row-${id}`,
  id,
  name,
  place,
  doing,
});

const pips = (entries: RunEntry[], wait = null as Parameters<typeof summarize>[2], directing = true) =>
  summarize(FLOW, entries, wait, directing).steps.map((step) => step.pip);

describe("where a run stands", () => {
  it("names the workflow before anything is started, every step to come", () => {
    const run = summarize(FLOW, [], null, true);
    expect(run.text).toBe("Plan, work, review");
    expect(run.begun).toBe(false);
    expect(run.steps.map((step) => step.pip)).toEqual(["todo", "todo", "todo"]);
    expect(run.spoken).toBe("Plan, work, review: Plan, work, review. Plan to come, Work to come, Review to come.");
  });

  it("follows one piece through a whole run", () => {
    const planned = entry("p1", "Plan the startup fix", plan, "working");
    let run = summarize(FLOW, [planned], null, true);
    expect(run.text).toBe("Plan");
    expect(run.steps.map((step) => step.pip)).toEqual(["live", "todo", "todo"]);

    // Plan done, work on its own piece.
    const done = { ...planned, doing: "done" as const };
    run = summarize(FLOW, [done, entry("w1", "Fix the cache", work(null), "working")], null, true);
    expect(run.text).toBe("Work");
    expect(run.steps.map((step) => step.pip)).toEqual(["done", "live", "todo"]);

    // The first review.
    const worked = entry("w1", "Fix the cache", work(null), "done");
    run = summarize(FLOW, [done, worked, entry("r1", "Review the cache fix", review("w1", 1), "working")], null, true);
    expect(run.text).toBe("Review, round 1 of 4");
    expect(run.steps.map((step) => step.pip)).toEqual(["done", "done", "live"]);

    // Sent back: the work goes on in the second round, and the review is
    // to come again.
    const reviewed = entry("r1", "Review the cache fix", review("w1", 1), "done");
    run = summarize(FLOW, [done, { ...worked, place: work(null, 2), doing: "working" }, reviewed], null, true);
    expect(run.text).toBe("Work, round 2 of 4");
    expect(run.steps.map((step) => step.pip)).toEqual(["done", "live", "todo"]);
    expect(run.spoken).toBe("Plan, work, review: Work, round 2 of 4. Plan done, Work now, Review to come.");

    // Back from that round and at rest, before the next review: it still
    // stands in work, not in the review it had.
    run = summarize(FLOW, [done, { ...worked, place: work(null, 2) }, reviewed], null, true);
    expect(run.text).toBe("Work, round 2 of 4");

    // Past the last round the user is asked, and the chip says so.
    const last = entry("r1", "Review the cache fix", review("w1", 4), "done");
    run = summarize(FLOW, [done, { ...worked, place: work(null, 4) }, last], { step: "Review", done: 4, limit: 3 }, false);
    expect(run.text).toBe("Round 4 of 4 done, asks you");
    expect(run.waits).toBe(true);
    expect(run.steps.map((step) => step.pip)).toEqual(["done", "done", "live"]);

    // Done once the work has come through the review and nothing is at
    // work, the orchestrator included.
    const passed = [done, { ...worked, place: work(null, 2) }, entry("r1", "Review the cache fix", review("w1", 2), "done")];
    expect(summarize(FLOW, passed, null, true).text).toBe("Review, round 2 of 4");
    run = summarize(FLOW, passed, null, false);
    expect(run.text).toBe("Done");
    expect(run.done).toBe(true);
    expect(run.steps.map((step) => step.pip)).toEqual(["done", "done", "done"]);
  });

  it("counts the pieces in each step when they stand in different ones, with the rounds in the steps", () => {
    const entries = [
      entry("p1", "Plan the startup fix", plan, "done"),
      entry("w1", "Fix the cache", work(null, 2), "done"),
      entry("r2", "Review the cache fix", review("w1", 2), "working"),
      entry("w2", "Palette filter", work(null), "working"),
    ];
    const run = summarize(FLOW, entries, null, true);
    expect(run.text).toBe("1 in Work, 1 in Review");
    expect(run.steps.map((step) => step.pip)).toEqual(["done", "live", "live"]);
    expect(run.steps.map((step) => step.sessions.map((session) => `${session.words} · ${session.name}`))).toEqual([
      ["done · Plan the startup fix"],
      ["round 2 of 4, done · Fix the cache", "working · Palette filter"],
      ["round 2 of 4, working · Review the cache fix"],
    ]);
    // Two pieces in one step.
    const both = [entry("w1", "Fix the cache", work(null), "working"), entry("w2", "Palette filter", work(null), "asking")];
    expect(summarize(FLOW, both, null, true).text).toBe("2 in Work");
  });

  it("lists the latest session of each piece in a step, with a way to it while its row stands", () => {
    const entries = [
      entry("w1", "Fix the cache", work(null, 2), "working"),
      entry("r1", "Review the cache fix", review("w1", 1), "done"),
      { ...entry("r0", "First review", review("w1", 1), "done"), key: null },
    ];
    const run = summarize(FLOW, entries, null, true);
    const reviews = run.steps[2].sessions;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ key: "row-r1", words: "round 1 of 4, done" });
  });

  it("leaves out a session for a step the workflow no longer has", () => {
    const gone: RunPlace = { step: "Deploy", kind: "work", piece: null, round: null };
    expect(pips([entry("d1", "Ship it", gone, "working")])).toEqual(["todo", "todo", "todo"]);
  });

  it("says a deleted workflow by the name it is given", () => {
    expect(summarize(FLOW, [], null, true, "Plan, work, review (deleted)").workflow).toBe("Plan, work, review (deleted)");
  });
});

describe("a place in words", () => {
  it("says a review's round of the most, and work's from its second round", () => {
    expect(placeLong(placeWords(FLOW, review("w1", 2)))).toBe("Review, round 2 of 4");
    expect(placeShort(placeWords(FLOW, review("w1", 2)))).toBe("Review, 2 of 4");
    expect(placeLong(placeWords(FLOW, work("w1")))).toBe("Work");
    expect(placeLong(placeWords(FLOW, work("w1", 1)))).toBe("Work");
    expect(placeShort(placeWords(FLOW, work("w1", 3)))).toBe("Work, 3 of 4");
    expect(roundText(placeWords(FLOW, work("w1", 3)))).toBe("round 3 of 4");
    // A step no review sends back to has no rounds.
    expect(placeShort(placeWords(FLOW, { ...plan, round: 2 }))).toBe("Plan");
  });

  it("says the round alone where the workflow is not known", () => {
    expect(placeLong(placeWords(null, review("w1", 2)))).toBe("Review, round 2");
    expect(placeShort(placeWords(null, review("w1", 2)))).toBe("Review, 2");
    expect(placeLong(placeWords(null, work("w1", 2)))).toBe("Work");
  });

  it("matches a step in any case of A to Z, and says it as the workflow names it", () => {
    expect(placeLong(placeWords(FLOW, { ...review("w1", 1), step: "review" }))).toBe("Review, round 1 of 4");
  });
});
