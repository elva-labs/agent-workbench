import { describe, expect, it } from "vitest";
import { Conversation } from "$lib/conversation.svelte";
import type { IntegratedEventBody } from "$lib/core";
import { ABOUT_MOST, subagentNote, subagentSaid, subagentWords, subagentsOf } from "$lib/subagents";

/** A conversation driven event by event, on a clock the test moves. */
function driven() {
  let now = 1000;
  const conversation = new Conversation(() => now);
  const at = (ms: number) => (now = ms);
  const play = (...events: IntegratedEventBody[]) => {
    for (const event of events) conversation.apply(event);
  };
  return { conversation, at, play };
}

const turn = (): IntegratedEventBody => ({ type: "turnStarted", messages: [] });
const ended = (): IntegratedEventBody => ({
  type: "turnEnded",
  outcome: "done",
  error: null,
  totalCostUsd: null,
  durationMs: null,
  usage: null,
});
const state = (value: "working" | "idle"): IntegratedEventBody => ({ type: "state", state: value });

/** A call that starts a subagent, its input whole. */
function agentCall(call: string, input: Record<string, unknown>, parent: string | null = null): IntegratedEventBody[] {
  return [
    { type: "toolStarted", call, parent, name: "Agent", kind: "agent" },
    { type: "toolInput", call, parent, delta: null, input, truncated: false },
  ];
}

const finished = (call: string, error = false): IntegratedEventBody => ({
  type: "toolFinished",
  call,
  parent: null,
  output: "done",
  error,
  truncated: false,
  changes: [],
});

const task = (id: string, call: string, background = false): IntegratedEventBody => ({
  type: "taskStarted",
  task: id,
  call,
  kind: "agent",
  description: null,
  prompt: null,
  background,
  ambient: false,
});

const taskEnded = (id: string, call: string, status: "completed" | "failed" | "stopped" | "lost" = "completed"): IntegratedEventBody => ({
  type: "taskFinished",
  task: id,
  call,
  status,
  summary: null,
  reports: true,
});

describe("subagentsOf", () => {
  it("shows a subagent while it runs, with what it was asked and its kind", () => {
    const { conversation, at, play } = driven();
    play(state("working"), turn());
    at(2000);
    play(...agentCall("c1", { description: "Read the per-project scan", subagent_type: "Explore", prompt: "Read it" }));
    expect(subagentsOf(conversation)).toEqual([
      { call: "c1", about: "Read the per-project scan", kind: "Explore", state: "running", at: 2000 },
    ]);
  });

  it("says general for the general-purpose kind and takes the prompt's first line with no description", () => {
    const { conversation, play } = driven();
    play(state("working"), turn(), ...agentCall("c1", { prompt: "\n  Find where the scan starts\nThen report.", subagent_type: "general-purpose" }));
    expect(subagentsOf(conversation)[0]).toMatchObject({ about: "Find where the scan starts", kind: "general" });
  });

  it("reads what it was asked while the input still streams", () => {
    const { conversation, play } = driven();
    play(state("working"), turn(), { type: "toolStarted", call: "c1", parent: null, name: "Agent", kind: "agent" });
    expect(subagentsOf(conversation)[0]).toMatchObject({ about: null, kind: null, state: "running" });
    play({ type: "toolInput", call: "c1", parent: null, delta: '{"description":"Run the cache tests","prom', input: null, truncated: false });
    expect(subagentsOf(conversation)[0]).toMatchObject({ about: "Run the cache tests", kind: null });
  });

  it("cuts what the agent wrote to what a row holds", () => {
    const { conversation, play } = driven();
    play(state("working"), turn(), ...agentCall("c1", { description: "x".repeat(400), subagent_type: "k".repeat(60) }));
    const [one] = subagentsOf(conversation);
    expect(Array.from(one.about!)).toHaveLength(ABOUT_MOST);
    expect(one.about!.endsWith("…")).toBe(true);
    expect(one.kind!.length).toBeLessThanOrEqual(20);
  });

  it("keeps a done subagent, greyed, until the turn ends, then lets it go", () => {
    const { conversation, at, play } = driven();
    play(state("working"), turn(), ...agentCall("c1", { description: "one", subagent_type: "Explore" }), task("t1", "c1"));
    play(...agentCall("c2", { description: "two", subagent_type: "Plan" }), task("t2", "c2"));
    at(5000);
    play(taskEnded("t1", "c1"), finished("c1"));
    expect(subagentsOf(conversation).map((one) => [one.call, one.state, one.at])).toEqual([
      ["c1", "done", 5000],
      ["c2", "running", 1000],
    ]);
    at(6000);
    play(taskEnded("t2", "c2"), finished("c2"));
    expect(subagentsOf(conversation).map((one) => one.state)).toEqual(["done", "done"]);
    at(7000);
    play(ended(), state("idle"));
    expect(subagentsOf(conversation)).toEqual([]);
  });

  it("follows a subagent in the background past the turn that started it, until the turn its report starts ends", () => {
    const { conversation, at, play } = driven();
    play(state("working"), turn(), ...agentCall("c1", { description: "slow", subagent_type: "Explore" }), task("t1", "c1", true));
    // Started in the background, the call returns at once.
    play(finished("c1"));
    at(2000);
    play(ended());
    expect(subagentsOf(conversation).map((one) => one.state)).toEqual(["running"]);
    at(3000);
    play(taskEnded("t1", "c1"));
    expect(subagentsOf(conversation)).toEqual([{ call: "c1", about: "slow", kind: "Explore", state: "done", at: 3000 }]);
    at(4000);
    play(turn());
    expect(subagentsOf(conversation).map((one) => one.state)).toEqual(["done"]);
    at(5000);
    play(ended(), state("idle"));
    expect(subagentsOf(conversation)).toEqual([]);
  });

  it("lets a subagent done before its turn ended go with that turn while another still runs", () => {
    const { conversation, at, play } = driven();
    play(state("working"), turn(), ...agentCall("c1", { description: "quick" }), task("t1", "c1", true), finished("c1"));
    play(...agentCall("c2", { description: "slow" }), task("t2", "c2", true), finished("c2"));
    at(2000);
    play(taskEnded("t1", "c1"));
    at(3000);
    play(ended());
    expect(subagentsOf(conversation).map((one) => one.call)).toEqual(["c2"]);
  });

  it("drops what is done once the session is idle with no turn to end", () => {
    const { conversation, at, play } = driven();
    play(state("working"), turn(), ...agentCall("c1", { description: "bg" }), task("t1", "c1", true), finished("c1"));
    at(2000);
    play(ended());
    at(3000);
    play(taskEnded("t1", "c1"));
    expect(subagentsOf(conversation)).toHaveLength(1);
    play(state("idle"));
    expect(subagentsOf(conversation)).toEqual([]);
  });

  it("says a subagent asks when a request comes from inside it, or to start it", () => {
    const { conversation, at, play } = driven();
    play(state("working"), turn(), ...agentCall("c1", { description: "Run the cache tests", subagent_type: "general-purpose" }));
    play({ type: "toolStarted", call: "inner", parent: "c1", name: "Bash", kind: "command" });
    at(4000);
    play({
      type: "permissionAsked",
      request: "r1",
      call: "inner",
      parent: "c1",
      tool: "Bash",
      input: { command: "cargo test" },
      truncated: false,
      description: null,
      path: null,
      choices: [],
    });
    play(...agentCall("c2", { description: "Check the names" }));
    play({ type: "permissionAsked", request: "r2", call: "c2", parent: null, tool: "Agent", input: {}, truncated: false, description: null, path: null, choices: [] });
    expect(subagentsOf(conversation).map((one) => [one.call, one.state, one.at])).toEqual([
      ["c1", "asking", 4000],
      ["c2", "asking", 4000],
    ]);
    play({ type: "answered", request: "r1", choice: "allow", answers: null, message: null });
    expect(subagentsOf(conversation)[0].state).toBe("running");
  });

  it("names a failed or stopped run as such", () => {
    const { conversation, play } = driven();
    play(state("working"), turn());
    play(...agentCall("c1", { description: "a" }), task("t1", "c1"), taskEnded("t1", "c1", "failed"), finished("c1", true));
    play(...agentCall("c2", { description: "b" }), task("t2", "c2"), taskEnded("t2", "c2", "stopped"), finished("c2"));
    play(...agentCall("c3", { description: "c" }), finished("c3", true));
    expect(subagentsOf(conversation).map((one) => one.state)).toEqual(["failed", "stopped", "failed"]);
  });

  it("leaves out other calls, a subagent's own calls, housekeeping and earlier turns' work", () => {
    const { conversation, at, play } = driven();
    play(state("working"), turn(), ...agentCall("old", { description: "old" }), finished("old"));
    at(2000);
    play(ended());
    at(3000);
    play(turn());
    play({ type: "toolStarted", call: "b1", parent: null, name: "Bash", kind: "command" });
    play(...agentCall("c1", { description: "mine" }));
    play(...agentCall("nested", { description: "deeper" }, "c1"));
    play({ type: "taskStarted", task: "h", call: "c1", kind: "agent", description: null, prompt: null, background: true, ambient: true });
    expect(subagentsOf(conversation).map((one) => one.call)).toEqual(["c1"]);
  });

  it("lets everything go when the session ends", () => {
    const { conversation, play } = driven();
    play(state("working"), turn(), ...agentCall("c1", { description: "a" }), task("t1", "c1", true));
    play({ type: "ended", code: 1, clean: false });
    expect(subagentsOf(conversation)).toEqual([]);
  });
});

describe("the words for subagents", () => {
  const one = (state: "running" | "asking" | "done" | "failed", kind: string | null = "Explore") => ({
    call: `c${Math.random()}`,
    about: "Read the scan",
    kind,
    state,
    at: 0,
  });

  it("counts them for the session's own row", () => {
    expect(subagentWords([one("running"), one("running")])).toBe("2 subagents running");
    expect(subagentWords([one("running"), one("asking"), one("done")])).toBe("1 subagent running, 1 asking, 1 done");
    expect(subagentWords([one("asking")])).toBe("1 subagent asking");
    expect(subagentWords([one("done"), one("failed")])).toBe("2 subagents done");
  });

  it("says the kind while running, else the state", () => {
    expect(subagentNote(one("running"))).toBe("Explore");
    expect(subagentNote(one("running", null))).toBeNull();
    expect(subagentNote(one("asking"))).toBe("asking");
    expect(subagentNote(one("done"))).toBe("done");
  });

  it("says the row whole for a screen reader", () => {
    expect(subagentSaid(one("asking"))).toBe("Subagent for Read the scan, Explore, asking for a permission");
    expect(subagentSaid({ ...one("running", null), about: null })).toBe("A subagent, running");
  });
});
