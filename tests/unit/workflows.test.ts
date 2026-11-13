import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings, Workflow } from "$lib/core";
import {
  addStep,
  addWorkflow,
  adoptWorkflows,
  defaultWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  moveStep,
  overrideOf,
  removeStep,
  renameWorkflow,
  reset,
  setDefault,
  setOrchestrator,
  setOverride,
  setStepKind,
  updateStep,
  workflowOf,
  listProblem,
  moveProblem,
  readWorkflow,
  removeProblem,
  removeUnread,
  setProblem,
  workflowProblem,
  workflows,
  workflowsSettings,
} from "$lib/workflows.svelte";
import rules from "../fixtures/workflow-rules.json";

const sent: unknown[] = [];
/** What the core answers the next change with: null keeps it. */
let refusal: string | null = null;
/** What the core says it holds when asked. */
let stored: Settings["workflows"] | null = null;

vi.mock("$lib/persist", () => ({
  persist: (change: unknown) => {
    sent.push(change);
    return Promise.resolve(refusal);
  },
}));

vi.mock("$lib/core", () => ({
  core: () => ({
    settingsGet: async () => ({ stored: true, settings: { workflows: stored } }),
  }),
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const NAME = "Build and review";
const A = "/repo/one";

const stepsOf = () => workflows.list[0].steps;

beforeEach(() => {
  reset();
  sent.length = 0;
  refusal = null;
  stored = null;
  adoptWorkflows(undefined);
});

describe("a fresh window", () => {
  it("has the default workflow, marked for new sessions", () => {
    expect(workflows.list).toEqual([defaultWorkflow()]);
    expect(workflows.default).toBe(NAME);
    const workflow = workflows.list[0];
    expect(workflow.orchestrator).toEqual({ agent: "claude-code", model: "fable" });
    expect(workflow.steps.map((step) => step.kind)).toEqual(["work", "review"]);
    expect(workflowProblem(workflow)).toBeNull();
  });

  it("takes the core's workflows, and drops a choice that names one it does not hold", () => {
    const other = { ...defaultWorkflow(), name: "Quick" };
    adoptWorkflows({
      list: [other],
      default: "Gone",
      overrides: { [A]: "Quick", "/b": "Gone", "/c": null },
    });
    expect(workflows.list).toEqual([other]);
    expect(workflows.default).toBeNull();
    expect(workflows.overrides).toEqual({ [A]: "Quick", "/c": null });
  });

  it("keeps none at all when the core says there are none", () => {
    adoptWorkflows({ list: [], default: null, overrides: {} });
    expect(workflows.list).toEqual([]);
    expect(workflowOf(A)).toBeNull();
  });
});

describe("the list of workflows", () => {
  it("adds a numbered workflow of the default shape and sends it", () => {
    expect(addWorkflow()).toBe("New workflow");
    expect(addWorkflow()).toBe("New workflow 2");
    expect(workflows.list.map((workflow) => workflow.name)).toEqual([NAME, "New workflow", "New workflow 2"]);
    expect(sent).toHaveLength(2);
    expect((sent[1] as { workflows: { list: unknown[] } }).workflows.list).toHaveLength(3);
  });

  it("duplicates one next to it under a name of its own", () => {
    expect(duplicateWorkflow(NAME)).toBe(`${NAME} copy`);
    expect(duplicateWorkflow(NAME)).toBe(`${NAME} copy 2`);
    expect(workflows.list[1].steps).toEqual(workflows.list[0].steps);
    expect(workflows.list[1].steps).not.toBe(workflows.list[0].steps);
  });

  it("renames one, keeping the default and the projects that named it", () => {
    setOverride(A, NAME);
    expect(renameWorkflow(NAME, "Careful")).toBeNull();
    expect(workflows.list[0].name).toBe("Careful");
    expect(workflows.default).toBe("Careful");
    expect(workflows.overrides[A]).toBe("Careful");
  });

  it("refuses a name that is empty, long or taken", () => {
    addWorkflow();
    expect(renameWorkflow("New workflow", "  ")).not.toBeNull();
    expect(renameWorkflow("New workflow", "x".repeat(41))).not.toBeNull();
    expect(renameWorkflow("New workflow", NAME.toUpperCase())).toMatch(/taken|already/);
    expect(workflows.list[1].name).toBe("New workflow");
  });

  it("deleting the default leaves new sessions with none, and projects follow it", () => {
    setOverride(A, NAME);
    deleteWorkflow(NAME);
    expect(workflows.list).toEqual([]);
    expect(workflows.default).toBeNull();
    expect(overrideOf(A)).toBeUndefined();
  });

  it("marks the default, and none is a choice", () => {
    addWorkflow();
    setDefault("New workflow");
    expect(workflows.default).toBe("New workflow");
    setDefault(null);
    expect(workflows.default).toBeNull();
    setDefault("Nowhere");
    expect(workflows.default).toBeNull();
  });

  it("holds sixteen workflows at most", () => {
    for (let n = 0; n < 20; n += 1) addWorkflow();
    expect(workflows.list).toHaveLength(16);
    expect(duplicateWorkflow(NAME)).toBeNull();
  });
});

describe("a project's choice", () => {
  it("follows the default until it names a workflow of its own, or none", () => {
    addWorkflow();
    expect(workflowOf(A)?.name).toBe(NAME);
    setOverride(A, "New workflow");
    expect(workflowOf(A)?.name).toBe("New workflow");
    setOverride(A, null);
    expect(overrideOf(A)).toBeNull();
    expect(workflowOf(A)).toBeNull();
    setOverride(A, undefined);
    expect(overrideOf(A)).toBeUndefined();
    expect(workflowOf(A)?.name).toBe(NAME);
    expect(sent.at(-1)).toMatchObject({ workflows: { overrides: {} } });
  });

  it("will not name a workflow there is not", () => {
    setOverride(A, "Gone");
    expect(workflows.overrides).toEqual({});
  });
});

describe("the orchestrator and the steps", () => {
  it("sets the orchestrator's model", () => {
    expect(setOrchestrator(NAME, { agent: "codex", model: "default" })).toBeNull();
    expect(workflows.list[0].orchestrator).toEqual({ agent: "codex", model: "default" });
    expect(setOrchestrator(NAME, { agent: "codex", model: "" })).not.toBeNull();
    expect(workflows.list[0].orchestrator.model).toBe("default");
  });

  it("adds a step on an arrow with a free name", () => {
    expect(addStep(NAME, 1, "work")).toBeNull();
    expect(stepsOf().map((step) => step.name)).toEqual(["Work", "Work 2", "Review"]);
    expect(addStep(NAME, 3, "review")).toBeNull();
    const added = stepsOf()[3];
    // A new review goes back to the nearest work step, never to a review.
    expect(added).toMatchObject({ kind: "review", name: "Review of Work 2", backTo: "Work 2" });
  });

  it("points a review at the nearest earlier work step when its own goes, never at a review", () => {
    // Work, Review (back to Work), Work 2, Review of Work 2 (back to Work 2).
    addStep(NAME, 2, "work");
    addStep(NAME, 3, "review");
    expect(stepsOf()[3]).toMatchObject({ name: "Review of Work 2", backTo: "Work 2" });
    expect(removeStep(NAME, 2)).toBeNull();
    expect(stepsOf()[2]).toMatchObject({ name: "Review of Work 2", backTo: "Work" });
    expect(updateStep(NAME, 2, { backTo: "Review" })).toMatch(/work step before it/);
    // Turning the target into a review sends its review further back.
    addStep(NAME, 1, "work");
    expect(updateStep(NAME, 3, { backTo: "Work 2" })).toBeNull();
    expect(setStepKind(NAME, 1, "review")).toBeNull();
    expect(stepsOf()[3]).toMatchObject({ backTo: "Work" });
  });

  it("will not begin with a review", () => {
    expect(addStep(NAME, 0, "review")).not.toBeNull();
    expect(setStepKind(NAME, 0, "review")).not.toBeNull();
  });

  it("removes a step, sending the review that went back to it to the step before, or refusing", () => {
    addStep(NAME, 1, "work");
    expect(removeStep(NAME, 1)).toBeNull();
    expect(stepsOf().map((step) => step.name)).toEqual(["Work", "Review"]);
    // The first step is the review's target and nothing is before it.
    expect(removeStep(NAME, 0)).not.toBeNull();
    expect(stepsOf()).toHaveLength(2);
    expect(removeStep(NAME, 1)).toBeNull();
    expect(removeStep(NAME, 0)).not.toBeNull();
    expect(stepsOf()).toHaveLength(1);
    addStep(NAME, 1, "review");
    addStep(NAME, 1, "work");
    // The review that went back to the first step goes back to the one before it.
    expect(removeStep(NAME, 0)).toBeNull();
    expect(stepsOf().map((step) => step.name)).toEqual(["Work 2", "Review of Work"]);
    expect(stepsOf()[1]).toMatchObject({ backTo: "Work 2" });
    expect(removeStep(NAME, 0)).not.toBeNull();
  });

  it("moves a step, keeping reviews pointed at something before them", () => {
    addStep(NAME, 1, "work");
    expect(stepsOf().map((step) => step.name)).toEqual(["Work", "Work 2", "Review"]);
    expect(moveStep(NAME, 1, 0)).toBeNull();
    expect(stepsOf().map((step) => step.name)).toEqual(["Work 2", "Work", "Review"]);
    // A review cannot lead.
    expect(moveStep(NAME, 2, 0)).not.toBeNull();
    // Moving the target past its review repoints the review.
    expect(moveStep(NAME, 1, 2)).toBeNull();
    const review = stepsOf()[1];
    expect(review).toMatchObject({ kind: "review", backTo: "Work 2" });
  });

  it("renames a step and the reviews that go back to it", () => {
    expect(updateStep(NAME, 0, { name: "Build" })).toBeNull();
    expect(stepsOf()[1]).toMatchObject({ backTo: "Build" });
    expect(updateStep(NAME, 1, { name: "build" })).toMatch(/taken/);
    expect(updateStep(NAME, 1, { name: "" })).not.toBeNull();
  });

  it("keeps a work step's sessions and a review's rounds within bounds", () => {
    expect(updateStep(NAME, 0, { parallel: 8 })).toBeNull();
    expect(updateStep(NAME, 0, { parallel: 9 })).not.toBeNull();
    expect(updateStep(NAME, 0, { parallel: 0 })).not.toBeNull();
    expect(updateStep(NAME, 0, { parallel: 1.5 })).not.toBeNull();
    expect(updateStep(NAME, 1, { limit: 10 })).toBeNull();
    expect(updateStep(NAME, 1, { limit: 11 })).not.toBeNull();
    expect(updateStep(NAME, 1, { limit: 0 })).not.toBeNull();
    expect(stepsOf()[0]).toMatchObject({ parallel: 8 });
    expect(stepsOf()[1]).toMatchObject({ limit: 10 });
  });

  it("needs at least one condition for a review to pass", () => {
    expect(updateStep(NAME, 1, { reviewerApproves: false })).toBeNull();
    expect(updateStep(NAME, 1, { orchestratorAgrees: false })).toMatch(/passes the work/);
    expect(stepsOf()[1]).toMatchObject({ reviewerApproves: false, orchestratorAgrees: true });
  });

  it("sends a review back only to a step before it", () => {
    addStep(NAME, 1, "work");
    expect(updateStep(NAME, 2, { backTo: "Work 2" })).toBeNull();
    expect(updateStep(NAME, 2, { backTo: "Review" })).not.toBeNull();
    expect(updateStep(NAME, 2, { backTo: "Nowhere" })).not.toBeNull();
    expect(stepsOf()[2]).toMatchObject({ backTo: "Work 2" });
  });

  it("sets the models a step may use, none meaning any", () => {
    const models = [
      { agent: "claude-code" as const, model: "opus" },
      { agent: "codex" as const, model: "default" },
    ];
    expect(updateStep(NAME, 1, { models })).toBeNull();
    expect(stepsOf()[1].models).toEqual(models);
    expect(updateStep(NAME, 1, { models: [] })).toBeNull();
    expect(stepsOf()[1].models).toEqual([]);
  });

  it("turns a step into the other kind, keeping its name and models", () => {
    addStep(NAME, 1, "work");
    expect(setStepKind(NAME, 1, "review")).toBeNull();
    expect(stepsOf()[1]).toMatchObject({ kind: "review", name: "Work 2", backTo: "Work", limit: 3 });
    expect(setStepKind(NAME, 1, "work")).toBeNull();
    expect(stepsOf()[1]).toMatchObject({ kind: "work", parallel: 1 });
  });

  it("holds twelve steps at most", () => {
    for (let n = 0; n < 15; n += 1) addStep(NAME, 1, "work");
    expect(stepsOf()).toHaveLength(12);
  });

  it("sends the whole set with each change", () => {
    updateStep(NAME, 0, { parallel: 2 });
    const settings = workflowsSettings();
    expect(sent.at(-1)).toEqual({ workflows: settings });
    expect((settings.list[0].steps[0] as { parallel: number }).parallel).toBe(2);
  });
});

describe("what makes a workflow valid", () => {
  const ok = (): Workflow => defaultWorkflow();

  it("is what the core takes, case by case, read the way an agent's is", () => {
    const takes = (set: unknown) => {
      try {
        const held = set as Settings["workflows"];
        const list = held.list.map((workflow) => readWorkflow(workflow));
        return setProblem({ ...held, list }) === null;
      } catch {
        return false;
      }
    };
    for (const { case: what, valid, workflow } of rules.cases) {
      expect(listProblem([workflow as Workflow]) === null, what).toBe(valid);
      expect(takes({ list: [workflow], default: null, overrides: {} }), what).toBe(valid);
    }
    for (const { case: what, valid, workflows: set } of rules.sets) {
      expect(takes(set), what).toBe(valid);
    }
  });

  it("needs at least one step", () => {
    const workflow = ok();
    workflow.steps = [];
    expect(workflowProblem(workflow)).toMatch(/at least one step/);
  });

  it("needs step names that differ, ignoring case", () => {
    const workflow = ok();
    workflow.steps[1].name = "work";
    (workflow.steps[1] as { backTo: string }).backTo = "Work";
    expect(workflowProblem(workflow)).toMatch(/taken/);
  });

  it("needs a review to name an earlier step", () => {
    const workflow = ok();
    workflow.steps.reverse();
    expect(workflowProblem(workflow)).toMatch(/before it/);
  });
});

describe("a workflow the file holds but cannot use", () => {
  const careful = {
    name: "Careful",
    reason: "the step Review of Careful goes back between 1 and 10 times, not 11",
    entry: { name: "Careful", steps: [] },
    at: 1,
    default: true,
    projects: [A, "/repo/two"],
  };

  it("is carried through every change the editor sends", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: {}, unread: [careful] });
    expect(workflows.unread).toEqual([careful]);
    setOrchestrator(NAME, { agent: "claude-code", model: "opus" });
    expect(sent.at(-1)).toMatchObject({ workflows: { unread: [careful] } });
  });

  it("stops being the default, or a project's choice, once the user chooses otherwise", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: {}, unread: [careful] });
    setOverride(A, NAME);
    expect(workflows.unread[0].projects).toEqual(["/repo/two"]);
    setDefault(NAME);
    expect(workflows.unread[0].default).toBe(false);
  });

  it("is taken out of the file when removed", () => {
    adoptWorkflows({ list: [defaultWorkflow()], default: null, overrides: {}, unread: [careful] });
    removeUnread(1);
    expect(workflows.unread).toEqual([]);
    expect((sent.at(-1) as { workflows: Settings["workflows"] }).workflows.unread).toBeUndefined();
  });
});

describe("a change the core refuses", () => {
  it("is said, and the window goes back to what is stored", async () => {
    stored = workflowsSettings();
    refusal = "could not write the settings file";
    expect(addWorkflow()).toBe("New workflow");
    expect(workflows.list).toHaveLength(2);
    await settle();
    await settle();
    expect(workflows.list.map((workflow) => workflow.name)).toEqual([NAME]);
    expect(workflows.refused).toBe("could not write the settings file");
    refusal = null;
    addWorkflow();
    expect(workflows.refused).toBeNull();
  });
});

describe("what would always be refused", () => {
  it("is known before a step is moved or removed, in terms of what was done", () => {
    const workflow = defaultWorkflow();
    expect(moveProblem(workflow, 0, -1)).toMatch(/first step already/);
    expect(moveProblem(workflow, 1, 2)).toMatch(/last step already/);
    expect(moveProblem(workflow, 0, 1)).toBe('"Review" would come first, and the first step does the work.');
    expect(moveProblem(workflow, 1, 0)).toBe('"Review" would come first, and the first step does the work.');
    expect(removeProblem(workflow, 0)).toBe('"Review" would come first, and the first step does the work.');
    expect(removeProblem(workflow, 1)).toBeNull();
    expect(moveStep(NAME, 0, 1)).toMatch(/would come first/);
  });
});

describe("a new review", () => {
  it("is named for the work it checks, so it does not read as coming after another", () => {
    expect(addStep(NAME, 1, "review")).toBeNull();
    expect(stepsOf().map((step) => step.name)).toEqual(["Work", "Review of Work", "Review"]);
    expect(addStep(NAME, 2, "review")).toBeNull();
    expect(stepsOf()[2].name).toBe("Review of Work 2");
  });
});
