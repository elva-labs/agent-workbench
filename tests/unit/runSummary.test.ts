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
  type RunStop,
  type RunWait,
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

/** The summary of a run, the orchestrator at work unless said. */
const run = (
  entries: RunEntry[],
  more: { wait?: RunWait | null; stops?: RunStop[]; directing?: boolean; workflow?: Workflow; name?: string } = {},
) =>
  summarize({
    workflow: more.workflow ?? FLOW,
    entries,
    wait: more.wait ?? null,
    stops: more.stops ?? [],
    directing: more.directing ?? true,
    name: more.name,
  });

const pips = (summary: ReturnType<typeof summarize>) => summary.steps.map((step) => step.pip);

describe("where a run stands", () => {
  it("names the workflow before anything is started, every step to come", () => {
    const at = run([]);
    expect(at.text).toBe("Plan, work, review");
    expect(at.begun).toBe(false);
    expect(pips(at)).toEqual(["todo", "todo", "todo"]);
    expect(at.spoken).toBe("Plan, work, review: Plan, work, review. Plan to come, Work to come, Review to come.");
  });

  it("follows one piece through a whole run, and says the last round finished, never more", () => {
    const planned = entry("p1", "Plan the startup fix", plan, "working");
    let at = run([planned]);
    expect(at.text).toBe("Plan");
    expect(pips(at)).toEqual(["live", "todo", "todo"]);

    // Plan done, work on its own piece.
    const done = { ...planned, doing: "done" as const };
    at = run([done, entry("w1", "Fix the cache", work(null), "working")]);
    expect(at.text).toBe("Work");
    expect(pips(at)).toEqual(["done", "live", "todo"]);

    // The first review.
    const worked = entry("w1", "Fix the cache", work(null), "done");
    at = run([done, worked, entry("r1", "Review the cache fix", review("w1", 1), "working")]);
    expect(at.text).toBe("Review, round 1 of 4");
    expect(pips(at)).toEqual(["done", "done", "live"]);

    // Sent back: the work goes on in the second round, and the review is
    // to come again.
    const reviewed = entry("r1", "Review the cache fix", review("w1", 1), "done");
    at = run([done, { ...worked, place: work(null, 2), doing: "working" }, reviewed]);
    expect(at.text).toBe("Work, round 2 of 4");
    expect(pips(at)).toEqual(["done", "live", "todo"]);
    expect(at.spoken).toBe("Plan, work, review: Work, round 2 of 4. Plan done, Work now, Review to come.");

    // Back from that round and at rest, before the next review: it still
    // stands in work, not in the review it had.
    at = run([done, { ...worked, place: work(null, 2) }, reviewed], { directing: false });
    expect(at.text).toBe("Work, round 2 of 4");
    expect(at.through).toBe(false);

    // Past the last round the user is asked, and the chip says so.
    const last = entry("r1", "Review the cache fix", review("w1", 4), "done");
    at = run([done, { ...worked, place: work(null, 4) }, last], { wait: { step: "Review", done: 4, limit: 3 }, directing: false });
    expect(at.text).toBe("Round 4 of 4 done, asks you");
    expect(at.waits).toBe(true);
    expect(pips(at)).toEqual(["done", "done", "live"]);

    // The last review rests: while the orchestrator works on, the review
    // is where the run stands; once it rests too, every pip is grey and
    // the words say the round that finished. Whether it passed is not
    // known, so the run is never called done.
    const finished = [done, { ...worked, place: work(null, 2) }, entry("r1", "Review the cache fix", review("w1", 2), "done")];
    expect(run(finished).text).toBe("Review, round 2 of 4");
    at = run(finished, { directing: false });
    expect(at.text).toBe("Review, round 2 of 4 done");
    expect(at.through).toBe(true);
    expect(pips(at)).toEqual(["done", "done", "done"]);
    expect(at.spoken).toBe("Plan, work, review: Review, round 2 of 4 done. Plan done, Work done, Review done.");
  });

  it("counts the pieces in each step when they stand in different ones, with the rounds in the steps", () => {
    const entries = [
      entry("p1", "Plan the startup fix", plan, "done"),
      entry("w1", "Fix the cache", work(null, 2), "done"),
      entry("r2", "Review the cache fix", review("w1", 2), "working"),
      entry("w2", "Palette filter", work(null), "working"),
    ];
    const at = run(entries);
    expect(at.text).toBe("1 in Work, 1 in Review");
    expect(pips(at)).toEqual(["done", "live", "live"]);
    expect(at.steps.map((step) => step.sessions.map((session) => `${session.words} · ${session.name}`))).toEqual([
      ["done · Plan the startup fix"],
      ["round 2 of 4, done · Fix the cache", "working · Palette filter"],
      ["round 2 of 4, working · Review the cache fix"],
    ]);
    // Two pieces in one step.
    const both = [entry("w1", "Fix the cache", work(null), "working"), entry("w2", "Palette filter", work(null), "asking")];
    expect(run(both).text).toBe("2 in Work");
  });

  it("is not through while a piece rests before its review, and counts the pieces at rest", () => {
    // One piece reviewed, one worked and never reviewed, all at rest.
    const entries = [
      entry("w1", "Fix the cache", work(null), "done"),
      entry("r1", "Review the cache fix", review("w1", 1), "done"),
      entry("w2", "Palette filter", work(null), "done"),
    ];
    const at = run(entries, { directing: false });
    expect(at.through).toBe(false);
    expect(at.text).toBe("1 in Work, 1 in Review");
    expect(pips(at)).toEqual(["done", "live", "live"]);
    // A crashed work session in its own piece is not through either.
    const crashed = [...entries.slice(0, 2), entry("w2", "Palette filter", work(null), "stopped")];
    expect(run(crashed, { directing: false }).text).toBe("1 in Work, 1 in Review");
    expect(run(crashed, { directing: false }).through).toBe(false);
  });

  it("leaves out a plan that was never carried on once another piece reached the work", () => {
    const entries = [
      entry("p1", "Plan the startup fix", plan, "done"),
      entry("w1", "Fix the cache", work(null), "done"),
      entry("r1", "Review the cache fix", review("w1", 1), "done"),
    ];
    const at = run(entries, { directing: false });
    expect(at.text).toBe("Review, round 1 of 4 done");
    expect(at.through).toBe(true);
    // Alone, the plan is where the run stands.
    expect(run([entries[0]], { directing: false }).text).toBe("Plan");
  });

  it("says where a piece the user stopped at the limit stands, in ink, until it goes on", () => {
    const entries = [
      entry("w1", "Fix the cache", work(null, 4), "done"),
      entry("r1", "Review the cache fix", review("w1", 4), "done"),
    ];
    const stops = [{ step: "Review", piece: "w1", round: 4 }];
    const at = run(entries, { stops, directing: false });
    expect(at.text).toBe("Stopped at round 4 of 4");
    expect(at.waits).toBe(false);
    expect(at.through).toBe(false);
    expect(pips(at)).toEqual(["done", "done", "live"]);
    expect(at.steps[2].sessions[0]).toMatchObject({
      words: "round 4 of 4, stopped at the limit",
      round: "round 4 of 4",
      state: "stopped at the limit",
      doing: "done",
    });
    // Its work back at it, the stop is the piece's past.
    const again = [{ ...entries[0], place: work(null, 5), doing: "working" as const }, entries[1]];
    expect(run(again, { stops }).text).toBe("Work, round 5 of 4");
  });

  it("is never through on a last session that crashed or ended unseen, and says so in the popover", () => {
    const worked = entry("w1", "Fix the cache", work(null), "done");
    for (const doing of ["stopped", "ended"] as const) {
      const at = run([worked, entry("r1", "Review the cache fix", review("w1", 1), doing)], { directing: false });
      expect(at.through, doing).toBe(false);
      expect(at.text, doing).toBe("Review, round 1 of 4");
      expect(pips(at), doing).toEqual(["done", "done", "live"]);
      expect(at.steps[2].sessions[0], doing).toMatchObject({ words: `round 1 of 4, ${doing}`, state: doing });
      expect(at.spoken, doing).toContain("Review now");
    }
    // The same for a one-step workflow's work.
    const one: Workflow = { ...FLOW, steps: [{ kind: "work", name: "Work", models: [], parallel: 2 }] };
    const crashed = run([entry("w1", "Fix the cache", work(null), "stopped")], { workflow: one, directing: false });
    expect(crashed.text).toBe("Work");
    expect(crashed.through).toBe(false);
    // An earlier round that crashed does not hold back a later one done.
    const later = run(
      [
        entry("w1", "Fix the cache", work(null, 2), "done"),
        entry("r0", "First review", review("w1", 1), "stopped"),
        entry("r1", "Second review", review("w1", 2), "done"),
      ],
      { directing: false },
    );
    expect(later.text).toBe("Review, round 2 of 4 done");
  });

  it("keeps a step lit where a piece works while the round question waits", () => {
    const entries = [
      entry("w1", "Fix the cache", work(null, 4), "done"),
      entry("r1", "Review the cache fix", review("w1", 4), "done"),
      entry("w2", "Palette filter", work(null), "working"),
    ];
    const at = run(entries, { wait: { step: "Review", done: 4, limit: 3 } });
    expect(at.text).toBe("Round 4 of 4 done, asks you");
    expect(pips(at)).toEqual(["done", "live", "live"]);
    expect(at.spoken).toContain("Work now");
  });

  it("says a one-step workflow's finished work as that", () => {
    const one: Workflow = { ...FLOW, steps: [{ kind: "work", name: "Work", models: [], parallel: 2 }] };
    const entries = [entry("w1", "Fix the cache", work(null), "done"), entry("w2", "Palette filter", work(null), "done")];
    expect(run(entries, { workflow: one }).text).toBe("2 in Work");
    const through = run(entries, { workflow: one, directing: false });
    expect(through.text).toBe("2 done in Work");
    expect(pips(through)).toEqual(["done"]);
    expect(run([entries[0]], { workflow: one, directing: false }).text).toBe("Work done");
  });

  it("speaks a step passed with nothing run for it as skipped, its pip grey", () => {
    const at = run([entry("w1", "Fix the cache", work(null), "working")]);
    expect(pips(at)).toEqual(["done", "live", "todo"]);
    expect(at.steps[0].skipped).toBe(true);
    expect(at.steps[1].skipped).toBe(false);
    expect(at.spoken).toBe("Plan, work, review: Work. Plan skipped, Work now, Review to come.");
  });

  it("reads work sent back under a version that kept no round of work as reviewed again", () => {
    // That version left the work's round empty, so a review that rests
    // after it reads as the latest: a run mid-flight across the upgrade
    // can read as through once.
    const entries = [entry("w1", "Fix the cache", work(null), "done"), entry("r1", "Review the cache fix", review("w1", 1), "done")];
    expect(run(entries, { directing: false }).text).toBe("Review, round 1 of 4 done");
  });

  it("lists the latest session of each piece in a step, with a way to it while its row stands", () => {
    const entries = [
      entry("w1", "Fix the cache", work(null, 2), "working"),
      entry("r1", "Review the cache fix", review("w1", 1), "done"),
      { ...entry("r0", "First review", review("w1", 1), "done"), key: null },
    ];
    const reviews = run(entries).steps[2].sessions;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ key: "row-r1", words: "round 1 of 4, done" });
  });

  it("leaves out a session for a step the workflow no longer has", () => {
    const gone: RunPlace = { step: "Deploy", kind: "work", piece: null, round: null };
    expect(pips(run([entry("d1", "Ship it", gone, "working")]))).toEqual(["todo", "todo", "todo"]);
  });

  it("says a deleted workflow by the name it is given", () => {
    expect(run([], { name: "Plan, work, review (deleted)" }).workflow).toBe("Plan, work, review (deleted)");
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
