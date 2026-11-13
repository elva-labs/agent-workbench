import { expect, test, type Page } from "@playwright/test";
import { PROJECT, SETTINGS_FILE, installFakeCore } from "./fake";

const MOD = "ControlOrMeta";
const AGENT = "section[data-pane='agent']";

const file = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), SETTINGS_FILE);

const step = (page: Page, name: string) =>
  page.locator(`[data-testid="workflow-step"][data-step="${name}"]`);

async function open(page: Page, settings?: Record<string, unknown>, agents?: string[]) {
  await installFakeCore(page, { open: [PROJECT], settings, agents });
  await page.goto("/");
  await expect(page.locator(AGENT)).toBeVisible();
  await page.keyboard.press(`${MOD}+,`);
  await page.getByTestId("settings-tab-workflows").click();
  await expect(page.getByTestId("settings-workflows")).toBeVisible();
}

test.describe("the workflows tab", () => {
  test("lists the default workflow, marked, with the orchestrator as the frame and the steps in it", async ({
    page,
  }) => {
    await open(page);
    const chip = page.locator('[data-testid="workflow-chip"][data-workflow="Build and review"]');
    await expect(chip).toBeVisible();
    await expect(chip.getByTestId("workflow-default-tag")).toBeVisible();

    const frame = await page.getByTestId("workflow-orchestrator").boundingBox();
    const work = await step(page, "Work").boundingBox();
    const review = await step(page, "Review").boundingBox();
    expect(frame && work && review).toBeTruthy();
    // The steps sit inside the orchestrator's frame, in order, side by side.
    expect(work!.x).toBeGreaterThanOrEqual(frame!.x);
    expect(work!.y).toBeGreaterThanOrEqual(frame!.y);
    expect(review!.x + review!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
    expect(review!.y + review!.height).toBeLessThanOrEqual(frame!.y + frame!.height);
    expect(review!.x).toBeGreaterThan(work!.x + work!.width);
    expect(Math.abs(review!.y - work!.y)).toBeLessThan(2);

    await expect(page.getByTestId("workflow-orchestrator-model")).toHaveValue("claude-code:fable");
    await expect(step(page, "Work")).toContainText("Sonnet");
    await expect(step(page, "Review")).toContainText("Opus");
  });

  test("draws the review's line back under the row to the work, with its limit beneath", async ({
    page,
  }) => {
    await open(page);
    const loop = page.getByTestId("workflow-loop");
    await expect(loop).toBeVisible();
    const work = (await step(page, "Work").boundingBox())!;
    const review = (await step(page, "Review").boundingBox())!;
    const line = (await loop.boundingBox())!;
    // It runs from the middle of the review to the middle of the work, under both.
    expect(Math.abs(line.x - (work.x + work.width / 2))).toBeLessThan(2);
    expect(Math.abs(line.x + line.width - (review.x + review.width / 2))).toBeLessThan(2);
    expect(line.y).toBeGreaterThanOrEqual(Math.max(work.y + work.height, review.y + review.height) - 2);
    const label = page.getByTestId("workflow-loop-label");
    await expect(label).toHaveText("Review: back to Work until both approve, 3 rounds at most");
    const text = (await label.boundingBox())!;
    expect(text.y).toBeGreaterThan(line.y);
  });

  test("unfolds what the orchestrator is told", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("workflow-told-list")).toBeHidden();
    await page.getByTestId("workflow-told-toggle").click();
    const list = page.getByTestId("workflow-told-list");
    await expect(list).toBeVisible();
    await expect(list.locator("li")).toHaveCount(4);
    await expect(list).toContainText("`start` tool");
    await expect(list).toContainText("at most 3 times");
  });

  test("changes the orchestrator's model at once and keeps it", async ({ page }) => {
    await open(page);
    await page.getByTestId("workflow-orchestrator-model").selectOption("claude-code:opus");
    await expect
      .poll(async () => (await file(page)).workflows.list[0].orchestrator)
      .toEqual({ agent: "claude-code", model: "opus" });
  });

  test("adds a step on an arrow, in the order the arrow stands", async ({ page }) => {
    await open(page);
    await page.locator('[data-testid="workflow-add"][data-at="1"]').click();
    await expect(page.getByTestId("workflow-add-choice")).toBeVisible();
    await page.getByTestId("workflow-add-work").click();
    await expect(page.getByTestId("workflow-add-choice")).toHaveCount(0);
    const boxes = await Promise.all(
      ["Work", "Work 2", "Review"].map(async (name) => (await step(page, name).boundingBox())!),
    );
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x);
    expect(boxes[2].x).toBeGreaterThan(boxes[1].x);
    await expect
      .poll(async () => (await file(page)).workflows.list[0].steps.map((s: { name: string }) => s.name))
      .toEqual(["Work", "Work 2", "Review"]);
  });

  test("reaches the plus and a step from the keyboard, and Escape closes only the choice", async ({
    page,
  }) => {
    await open(page);
    const plus = page.locator('[data-testid="workflow-add"][data-at="2"]');
    await plus.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("workflow-add-choice")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("workflow-add-choice")).toHaveCount(0);
    await expect(page.getByTestId("settings")).toBeVisible();
    await expect(plus).toBeFocused();
    await step(page, "Review").focus();
    await page.keyboard.press("Enter");
    await expect(step(page, "Review")).toHaveAttribute("aria-pressed", "true");
  });

  test("adds, renames, duplicates and deletes a workflow", async ({ page }) => {
    await open(page);
    await page.getByTestId("workflow-new").click();
    const chips = page.getByTestId("workflow-chip");
    await expect(chips).toHaveCount(2);
    await expect(page.getByTestId("workflow-name")).toHaveValue("New workflow");

    await page.getByTestId("workflow-name").fill("Quick fix");
    await page.getByTestId("workflow-name").press("Enter");
    await expect(page.locator('[data-testid="workflow-chip"][data-workflow="Quick fix"]')).toBeVisible();

    await page.getByTestId("workflow-duplicate").click();
    await expect(page.getByTestId("workflow-name")).toHaveValue("Quick fix copy");
    await expect(chips).toHaveCount(3);

    // A name that is taken is refused where the user is looking.
    await page.getByTestId("workflow-name").fill("quick fix");
    await page.getByTestId("workflow-name").press("Enter");
    await expect(page.getByTestId("workflow-problem")).toBeVisible();
    await expect(page.getByTestId("workflow-name")).toHaveValue("Quick fix copy");

    await page.getByTestId("workflow-delete").click();
    await page.getByTestId("workflow-delete-confirm-confirm").click();
    await expect(chips).toHaveCount(2);
    await expect
      .poll(async () => (await file(page)).workflows.list.map((w: { name: string }) => w.name))
      .toEqual(["Build and review", "Quick fix"]);
  });

  test("marks another workflow as the default, and none is a choice", async ({ page }) => {
    await open(page);
    await page.getByTestId("workflow-new").click();
    const flip = page.getByTestId("workflow-default");
    await expect(flip).toHaveAttribute("aria-checked", "false");
    await flip.click();
    await expect(flip).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await file(page)).workflows.default)
      .toBe("New workflow");
    const tags = page.getByTestId("workflow-default-tag");
    await expect(tags).toHaveCount(1);
    await flip.click();
    await expect(tags).toHaveCount(0);
    await expect(page.getByTestId("workflow-default-line")).toHaveText(
      "New sessions start with no workflow.",
    );
    await expect.poll(async () => (await file(page)).workflows.default).toBeNull();
  });

  test("lets a project choose another workflow, or none", async ({ page }) => {
    await open(page);
    await page.getByTestId("workflow-new").click();
    await page.getByTestId("workflow-overrides").click();
    const row = page.getByTestId("workflow-project-row");
    await expect(row).toBeVisible();
    await page.getByTestId("workflow-project-choice").selectOption("New workflow");
    await expect
      .poll(async () => (await file(page)).workflows.overrides)
      .toEqual({ [PROJECT]: "New workflow" });
    await page.getByTestId("workflow-project-choice").selectOption("@none");
    await expect
      .poll(async () => (await file(page)).workflows.overrides)
      .toEqual({ [PROJECT]: null });
    await page.getByTestId("workflow-project-choice").selectOption("@default");
    await expect.poll(async () => (await file(page)).workflows.overrides).toEqual({});
  });

  test("shows a workflow from a file in the same shape", async ({ page }) => {
    await open(page, {
      workflows: {
        list: [
          {
            name: "Plan first",
            orchestrator: { agent: "codex", model: "default" },
            steps: [
              { kind: "work", name: "Plan", models: [], parallel: 1 },
              { kind: "work", name: "Build", models: [], parallel: 3 },
              {
                kind: "review",
                name: "Check",
                models: [{ agent: "codex", model: "default" }],
                reviewerApproves: true,
                orchestratorAgrees: false,
                backTo: "Plan",
                limit: 2,
              },
            ],
          },
        ],
        default: null,
        overrides: {},
      },
    });
    await expect(page.getByTestId("workflow-default-tag")).toHaveCount(0);
    await expect(step(page, "Plan")).toContainText("Any model");
    await expect(step(page, "Check")).toContainText("Codex");
    const line = (await page.getByTestId("workflow-loop").boundingBox())!;
    const plan = (await step(page, "Plan").boundingBox())!;
    const check = (await step(page, "Check").boundingBox())!;
    expect(Math.abs(line.x - (plan.x + plan.width / 2))).toBeLessThan(2);
    expect(Math.abs(line.x + line.width - (check.x + check.width / 2))).toBeLessThan(2);
    await expect(page.getByTestId("workflow-loop-label")).toHaveText(
      "Check: back to Plan until the reviewer approves, 2 rounds at most",
    );
  });

  test("is a tab among the others, and the arrows reach it", async ({ page }) => {
    await open(page);
    const tabs = page.getByTestId("settings").locator("nav button");
    await expect(tabs.nth(3)).toHaveText("Workflows");
    await page.getByTestId("settings-tab-sessions").focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByTestId("settings-tab-workflows")).toBeFocused();
    await expect(page.getByTestId("settings-workflows")).toBeVisible();
  });
});

const stored = async (page: Page) => (await file(page)).workflows.list[0];

test.describe("the settings of a step", () => {
  test("stand beside the diagram and follow the step picked", async ({ page }) => {
    await open(page);
    const panel = page.getByTestId("step-settings");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("step-name")).toHaveValue("Work");
    const canvas = (await page.getByTestId("workflow-canvas").boundingBox())!;
    const beside = (await panel.boundingBox())!;
    expect(beside.x).toBeGreaterThanOrEqual(canvas.x + canvas.width);
    expect(beside.y).toBeLessThan(canvas.y + canvas.height);

    await step(page, "Review").click();
    await expect(page.getByTestId("step-name")).toHaveValue("Review");
    await expect(page.getByTestId("step-kind-review")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("step-approves")).toBeChecked();
    await expect(page.getByTestId("step-agrees")).toBeChecked();
    await expect(page.getByTestId("step-back-to")).toHaveValue("Work");
    await expect(page.getByTestId("step-limit")).toHaveValue("3");
    await step(page, "Work").click();
    await expect(page.getByTestId("step-parallel")).toHaveValue("1");
  });

  test("rename a step and the review that goes back to it follows", async ({ page }) => {
    await open(page);
    await page.getByTestId("step-name").fill("Build");
    await page.getByTestId("step-name").press("Enter");
    await expect(step(page, "Build")).toBeVisible();
    await expect(page.getByTestId("workflow-loop-label")).toContainText("back to Build");
    await expect.poll(async () => (await stored(page)).steps[1].backTo).toBe("Build");

    await page.getByTestId("step-name").fill("review");
    await page.getByTestId("step-name").press("Enter");
    await expect(page.getByTestId("step-problem")).toBeVisible();
    await expect(page.getByTestId("step-name")).toHaveValue("Build");
  });

  test("choose the models a step may use: any, or a set whose first is used", async ({ page }) => {
    await open(page, undefined, ["claude-code", "codex"]);
    await expect(page.getByTestId("step-model-any")).not.toBeChecked();
    const model = (name: string) => page.locator(`[data-testid="step-model"][data-model="${name}"]`);
    await expect(model("sonnet")).toBeChecked();
    await expect(page.getByTestId("step-model-first")).toBeVisible();
    await model("haiku").check();
    await model("sonnet").uncheck();
    await expect(page.getByTestId("step-model-first")).toBeVisible();
    await expect
      .poll(async () => (await stored(page)).steps[0].models)
      .toEqual([{ agent: "claude-code", model: "haiku" }]);
    // Both agents are installed, so both are offered, Codex under Claude.
    const claude = (await model("fable").boundingBox())!;
    const codex = (await model("default").boundingBox())!;
    expect(codex.y).toBeGreaterThan(claude.y);

    await model("default").check();
    await expect(page.getByTestId("step-model-use-first")).toBeVisible();
    await page.getByTestId("step-model-use-first").click();
    await expect
      .poll(async () => (await stored(page)).steps[0].models)
      .toEqual([
        { agent: "codex", model: "default" },
        { agent: "claude-code", model: "haiku" },
      ]);
    await expect(step(page, "Work")).toContainText("Codex");

    await page.getByTestId("step-model-any").check();
    await expect.poll(async () => (await stored(page)).steps[0].models).toEqual([]);
    await expect(step(page, "Work")).toContainText("Any model");
    await expect(model("haiku")).not.toBeChecked();
  });

  test("a work step says how many sessions may run at once, within bounds", async ({ page }) => {
    await open(page);
    await page.getByTestId("step-parallel").fill("4");
    await page.getByTestId("step-parallel").press("Enter");
    await expect.poll(async () => (await stored(page)).steps[0].parallel).toBe(4);
    await page.getByTestId("step-parallel").fill("9");
    await page.getByTestId("step-parallel").press("Enter");
    await expect(page.getByTestId("step-problem")).toBeVisible();
    await expect(page.getByTestId("step-parallel")).toHaveValue("4");
  });

  test("a review says when the work passes, at least one on, and where it goes back", async ({
    page,
  }) => {
    await open(page);
    await page.locator('[data-testid="workflow-add"][data-at="1"]').click();
    await page.getByTestId("workflow-add-work").click();
    await step(page, "Review").click();

    await page.getByTestId("step-approves").uncheck();
    await expect.poll(async () => (await stored(page)).steps[2].reviewerApproves).toBe(false);
    // The one condition left on is held, and says why, rather than refused.
    const agrees = page.getByTestId("step-agrees");
    await expect(agrees).toHaveAttribute("aria-disabled", "true");
    await expect(agrees).toHaveAccessibleDescription(/One of these stays on/);
    await agrees.click({ force: true });
    await expect(agrees).toBeChecked();
    await expect(page.getByTestId("step-problem")).toHaveCount(0);

    await page.getByTestId("step-back-to").selectOption("Work 2");
    await expect.poll(async () => (await stored(page)).steps[2].backTo).toBe("Work 2");
    await expect(page.getByTestId("workflow-loop")).toHaveAttribute("data-to", "Work 2");
    await page.getByTestId("step-limit").fill("5");
    await page.getByTestId("step-limit").press("Enter");
    await expect(page.getByTestId("workflow-loop-label")).toHaveText(
      "Review: back to Work 2 until the orchestrator agrees, 5 rounds at most",
    );
    // A review goes back only to a work step before it.
    const options = await page.getByTestId("step-back-to").locator("option").allTextContents();
    expect(options).toEqual(["Work", "Work 2"]);
  });

  test("reorder and remove steps, and a first step cannot be a review", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("step-kind-review")).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("step-move-earlier")).toHaveAttribute("aria-disabled", "true");
    // Without Work, Review would come first: removing it is held, with the reason.
    await expect(page.getByTestId("step-remove")).toHaveAttribute("aria-disabled", "true");

    await page.locator('[data-testid="workflow-add"][data-at="1"]').click();
    await page.getByTestId("workflow-add-work").click();
    await expect(page.getByTestId("step-name")).toHaveValue("Work 2");
    await page.getByTestId("step-move-earlier").click();
    await expect(page.getByTestId("step-name")).toHaveValue("Work 2");
    const first = (await step(page, "Work 2").boundingBox())!;
    const second = (await step(page, "Work").boundingBox())!;
    expect(first.x).toBeLessThan(second.x);

    await page.getByTestId("step-remove").click();
    await page.getByTestId("step-remove-confirm-confirm").click();
    await expect(step(page, "Work 2")).toHaveCount(0);
    await expect
      .poll(async () => (await stored(page)).steps.map((s: { name: string }) => s.name))
      .toEqual(["Work", "Review"]);
    await step(page, "Review").click();
    await page.getByTestId("step-remove").click();
    await page.getByTestId("step-remove-confirm-confirm").click();
    await expect(step(page, "Review")).toHaveCount(0);
    await expect(page.getByTestId("step-remove")).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByTestId("step-remove")).toHaveAccessibleDescription("A workflow needs at least one step.");
    await expect(page.getByTestId("workflow-loop")).toHaveCount(0);
  });

  test("turn a step into the other kind", async ({ page }) => {
    await open(page);
    await page.locator('[data-testid="workflow-add"][data-at="1"]').click();
    await page.getByTestId("workflow-add-work").click();
    await page.getByTestId("step-kind-review").click();
    await expect(page.getByTestId("step-back-to")).toBeVisible();
    await expect(page.locator('[data-testid="workflow-step"][data-step="Work 2"]')).toHaveAttribute(
      "data-kind",
      "review",
    );
    await expect(page.getByTestId("workflow-loop")).toHaveCount(2);
    await page.getByTestId("step-kind-work").click();
    await expect(page.getByTestId("step-parallel")).toBeVisible();
    await expect(page.getByTestId("workflow-loop")).toHaveCount(1);
  });

  test("stand under the diagram when the dialog is narrow", async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await open(page);
    const canvas = (await page.getByTestId("workflow-canvas").boundingBox())!;
    const under = (await page.getByTestId("step-settings").boundingBox())!;
    expect(under.y).toBeGreaterThanOrEqual(canvas.y + canvas.height);
  });

  test("walk from the diagram to the settings with the keyboard alone", async ({ page }) => {
    await open(page);
    await step(page, "Work").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-testid="workflow-add"][data-at="1"]')).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(step(page, "Review")).toBeFocused();
    await page.keyboard.press("Enter");
    await page.getByTestId("step-name").focus();
    await page.keyboard.press("Tab");
    // The kinds are a radio group: Tab lands on the one chosen.
    await expect(page.getByTestId("step-kind-review")).toBeFocused();
  });
});

test.describe("the models offered", () => {
  test("are those of the installed agents, and Codex only where it is installed", async ({ page }) => {
    await open(page);
    const models = page.locator('[data-testid="step-model"]');
    await expect(models).toHaveCount(4);
    await expect(page.locator('[data-testid="step-model"][data-agent="codex"]')).toHaveCount(0);
    await expect(page.getByTestId("workflow-orchestrator-model").locator("option")).toHaveText([
      "Fable",
      "Opus",
      "Sonnet",
      "Haiku",
    ]);
  });

  test("include both agents where both are installed, Codex as its own default", async ({ page }) => {
    await open(page, undefined, ["claude-code", "codex"]);
    await expect(page.locator('[data-testid="step-model"]')).toHaveCount(5);
    await expect(page.locator('[data-testid="step-model"][data-model="default"]')).toBeVisible();
    await expect(
      page.getByTestId("workflow-orchestrator-model").locator("option").last(),
    ).toHaveText("Codex");
    await page.getByTestId("workflow-orchestrator-model").selectOption("codex:default");
    await expect
      .poll(async () => (await file(page)).workflows.list[0].orchestrator)
      .toEqual({ agent: "codex", model: "default" });
  });

  test("keep showing a model of an agent that is not installed, where a workflow uses it", async ({
    page,
  }) => {
    await open(page, {
      workflows: {
        list: [
          {
            name: "Mixed",
            orchestrator: { agent: "claude-code", model: "fable" },
            steps: [
              {
                kind: "work",
                name: "Work",
                models: [{ agent: "codex", model: "default" }],
                parallel: 1,
              },
            ],
          },
        ],
        default: "Mixed",
        overrides: {},
      },
    });
    await expect(
      page.locator('[data-testid="step-model"][data-model="default"]'),
    ).toBeChecked();
  });
});

const claude = (model: string) => ({ agent: "claude-code", model });

/** Plan, Build, Check back to Plan on the orchestrator's word, and a final
    review back to Build: four steps and two loops. */
const fourSteps = {
  workflows: {
    list: [
      {
        name: "Plan, build, check",
        orchestrator: claude("fable"),
        steps: [
          { kind: "work", name: "Plan", models: [claude("opus")], parallel: 1 },
          { kind: "work", name: "Build", models: [claude("sonnet")], parallel: 3 },
          {
            kind: "review",
            name: "Check",
            models: [],
            reviewerApproves: false,
            orchestratorAgrees: true,
            backTo: "Plan",
            limit: 2,
          },
          {
            kind: "review",
            name: "Final review",
            models: [claude("opus")],
            reviewerApproves: true,
            orchestratorAgrees: true,
            backTo: "Build",
            limit: 3,
          },
        ],
      },
    ],
    default: "Plan, build, check",
    overrides: {},
  },
};

const box = async (page: Page, testid: string) => (await page.getByTestId(testid).boundingBox())!;

/** Whether an element is wholly inside the dialog, so seen without scrolling. */
const inDialog = async (page: Page, locator: ReturnType<Page["locator"]>) => {
  const dialog = await box(page, "settings");
  const it = (await locator.boundingBox())!;
  return (
    it.y >= dialog.y &&
    it.y + it.height <= dialog.y + dialog.height &&
    it.x >= dialog.x &&
    it.x + it.width <= dialog.x + dialog.width
  );
};

test.describe("the layout", () => {
  test("keeps one dialog size for every tab, so nothing moves when the tab changes", async ({ page }) => {
    await open(page);
    const workflows = await box(page, "settings");
    expect(Math.round(workflows.width)).toBe(1100);
    expect(Math.round(workflows.height)).toBe(820);
    const tabs = (await page.getByTestId("settings-tab-appearance").boundingBox())!;
    await page.getByTestId("settings-tab-appearance").click();
    expect(await box(page, "settings")).toEqual(workflows);
    expect((await page.getByTestId("settings-tab-appearance").boundingBox())!).toEqual(tabs);
  });

  test("shows a four-step workflow whole at 1440 by 900: the diagram, a review's settings to Remove, and the foot", async ({
    page,
  }) => {
    await open(page, fourSteps);
    await step(page, "Final review").click();
    const canvas = await box(page, "workflow-canvas");
    for (const name of ["Plan", "Build", "Check", "Final review"]) {
      const node = (await step(page, name).boundingBox())!;
      expect(node.x + node.width).toBeLessThanOrEqual(canvas.x + canvas.width);
    }
    const flow = page.getByTestId("workflow-flow");
    expect(await flow.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    // The step's settings stand beside the diagram.
    expect((await box(page, "step-settings")).x).toBeGreaterThanOrEqual(canvas.x + canvas.width);
    for (const testid of [
      "workflow-orchestrator-model",
      "step-back-to",
      "step-limit",
      "step-remove",
      "workflow-default",
      "workflow-delete",
    ]) {
      expect(await inDialog(page, page.getByTestId(testid)), testid).toBe(true);
    }
    const pane = page.getByTestId("workflow-step-pane");
    expect(await pane.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
    await expect(page.getByTestId("workflow-step-more")).toHaveCount(0);
  });

  test("decides beside or under from the window, never from how many steps there are", async ({ page }) => {
    await open(page);
    const beside = async () => {
      const canvas = await box(page, "workflow-canvas");
      return (await box(page, "step-settings")).x >= canvas.x + canvas.width;
    };
    expect(await beside()).toBe(true);
    await page.locator('[data-testid="workflow-add"][data-at="1"]').click();
    await page.getByTestId("workflow-add-work").click();
    await page.locator('[data-testid="workflow-add"][data-at="2"]').click();
    await page.getByTestId("workflow-add-work").click();
    await expect(step(page, "Work 3")).toBeVisible();
    expect(await beside()).toBe(true);
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect.poll(beside).toBe(false);
  });

  test("keeps the diagram in place while the step's settings scroll on their own, showing there is more", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page, fourSteps);
    await step(page, "Final review").click();
    const before = await box(page, "workflow-canvas");
    const pane = page.getByTestId("workflow-step-pane");
    expect(await pane.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await expect(page.getByTestId("workflow-step-more")).toBeVisible();
    await pane.evaluate((node) => (node.scrollTop = node.scrollHeight));
    await expect(page.getByTestId("workflow-step-more")).toHaveCount(0);
    await expect(page.getByTestId("step-remove")).toBeInViewport();
    expect(await box(page, "workflow-canvas")).toEqual(before);
    expect(await inDialog(page, page.getByTestId("workflow-delete"))).toBe(true);
  });

  test("scrolls only the row of steps where they do not fit, keeping the orchestrator's head and showing there is more", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 760, height: 900 });
    await open(page, fourSteps);
    const flow = page.getByTestId("workflow-flow");
    expect(await flow.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    await expect(page.getByTestId("workflow-more-after")).toBeVisible();
    await expect(page.getByTestId("workflow-more-before")).toHaveCount(0);
    const head = await box(page, "workflow-orchestrator-model");

    await step(page, "Final review").click();
    const canvas = await box(page, "workflow-canvas");
    const last = (await step(page, "Final review").boundingBox())!;
    expect(last.x + last.width).toBeLessThanOrEqual(canvas.x + canvas.width);
    await expect(page.getByTestId("workflow-more-before")).toBeVisible();
    const after = await box(page, "workflow-orchestrator-model");
    expect(after.x).toBe(head.x);
    expect(after.y).toBe(head.y);
  });
});

test.describe("the steps drawn at their narrowest", () => {
  test("keep each role on one line, two models side by side and the name whole", async ({ page }) => {
    await open(page, {
      workflows: {
        ...fourSteps.workflows,
        list: [
          {
            ...fourSteps.workflows.list[0],
            steps: fourSteps.workflows.list[0].steps.map((one) =>
              one.name === "Build" ? { ...one, models: [claude("sonnet"), { agent: "codex", model: "default" }] } : one,
            ),
          },
        ],
      },
    }, ["claude-code", "codex"]);
    await step(page, "Final review").click();
    for (const name of ["Plan", "Build", "Check", "Final review"]) {
      const node = step(page, name);
      const role = await node.locator(".role").evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        line: parseFloat(getComputedStyle(element).lineHeight),
        cut: element.scrollWidth > element.clientWidth,
      }));
      expect(role.height, name).toBeLessThan(role.line * 1.5);
      expect(role.cut, name).toBe(false);
      expect(await node.locator("b").evaluate((element) => element.scrollWidth <= element.clientWidth), name).toBe(true);
    }
    const chips = await step(page, "Build").locator(".models span").all();
    const [sonnet, codex] = await Promise.all(chips.map(async (chip) => (await chip.boundingBox())!));
    expect(Math.abs(sonnet.y - codex.y)).toBeLessThan(1);
    // The arrows that move it are a size to be used.
    const arrow = await box(page, "step-move-earlier");
    expect(arrow.width).toBeGreaterThanOrEqual(24);
    expect(arrow.height).toBeGreaterThanOrEqual(20);
  });
});

test.describe("the lines of reviews", () => {
  test("name their review and keep each label clear of every line and of each other", async ({ page }) => {
    await open(page, fourSteps);
    const labels = page.getByTestId("workflow-loop-label");
    await expect(labels).toHaveText([
      "Check: back to Plan until the orchestrator agrees, 2 rounds at most",
      "Final review: back to Build until both approve, 3 rounds at most",
    ]);
    const lines = await Promise.all(
      (await page.getByTestId("workflow-loop").all()).map(async (line) => (await line.boundingBox())!),
    );
    const texts = await Promise.all((await labels.all()).map(async (label) => (await label.boundingBox())!));
    const lowest = Math.max(...lines.map((line) => line.y + line.height));
    for (const text of texts) expect(text.y).toBeGreaterThanOrEqual(lowest);
    expect(texts[1].y).toBeGreaterThanOrEqual(texts[0].y + texts[0].height);
    const [first, second] = lines;
    expect(second.y + second.height).toBeGreaterThan(first.y + first.height);
  });

  test("arriving at one step, stand side by side and never cross", async ({ page }) => {
    await open(page, {
      workflows: {
        list: [
          {
            name: "Looks",
            orchestrator: claude("fable"),
            steps: [
              { kind: "work", name: "Work", models: [], parallel: 1 },
              {
                kind: "review",
                name: "First look",
                models: [],
                reviewerApproves: true,
                orchestratorAgrees: true,
                backTo: "Work",
                limit: 3,
              },
              {
                kind: "review",
                name: "Second look",
                models: [],
                reviewerApproves: true,
                orchestratorAgrees: false,
                backTo: "Work",
                limit: 2,
              },
            ],
          },
        ],
        default: "Looks",
        overrides: {},
      },
    });
    await expect(page.getByTestId("workflow-loop-label")).toHaveText([
      "First look: back to Work until both approve, 3 rounds at most",
      "Second look: back to Work until the reviewer approves, 2 rounds at most",
    ]);
    const inner = (await page.locator('[data-testid="workflow-loop"][data-from="First look"]').boundingBox())!;
    const outer = (await page.locator('[data-testid="workflow-loop"][data-from="Second look"]').boundingBox())!;
    // They arrive apart, the outer line to the left of the inner one, and
    // the outer one runs wholly around the inner one.
    expect(inner.x - outer.x).toBeGreaterThanOrEqual(6);
    expect(outer.x + outer.width).toBeGreaterThan(inner.x + inner.width);
    expect(outer.y + outer.height).toBeGreaterThan(inner.y + inner.height);
  });
});

test.describe("taking things away", () => {
  test("asks before deleting a workflow, says what follows, and Cancel or Escape keep it", async ({
    page,
  }) => {
    await open(page);
    await page.getByTestId("workflow-delete").click();
    const confirm = page.getByTestId("workflow-delete-confirm");
    await expect(confirm).toContainText('Delete the workflow "Build and review"?');
    await expect(confirm).toContainText("New sessions will start with no workflow.");
    await expect(page.getByTestId("workflow-delete-confirm-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(page.getByTestId("settings")).toBeVisible();
    await expect(page.getByTestId("workflow-delete")).toBeFocused();
    await page.getByTestId("workflow-delete").click();
    await page.getByTestId("workflow-delete-confirm-cancel").click();
    await expect(page.getByTestId("workflow-chip")).toHaveCount(1);

    await page.getByTestId("workflow-delete").click();
    await page.getByTestId("workflow-delete-confirm-confirm").click();
    await expect(page.getByTestId("workflow-chip")).toHaveCount(0);
    await expect.poll(async () => (await file(page)).workflows.list).toEqual([]);
  });

  test("keeps Delete away from Duplicate and draws it as destructive", async ({ page }) => {
    await open(page);
    const duplicate = await box(page, "workflow-duplicate");
    const remove = await box(page, "workflow-delete");
    expect(Math.abs(remove.y - duplicate.y) > 40 || Math.abs(remove.x - duplicate.x) > 200).toBe(true);
    const red = (testid: string) =>
      page.getByTestId(testid).evaluate((node) => getComputedStyle(node).color);
    const del = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--del)";
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    });
    expect(await red("workflow-delete")).toBe(del);
    expect(await red("step-remove")).toBe(del);
  });

  test("asks before removing a step, says which reviews go back elsewhere, and holds one it cannot remove", async ({
    page,
  }) => {
    await open(page);
    const remove = page.getByTestId("step-remove");
    await expect(remove).toHaveAttribute("aria-disabled", "true");
    await expect(remove).toHaveAccessibleDescription('"Review" would come first, and the first step does the work.');
    await expect(remove).toHaveAttribute("title", /would come first/);
    await remove.click({ force: true });
    await expect(page.getByTestId("step-remove-confirm")).toHaveCount(0);

    await page.locator('[data-testid="workflow-add"][data-at="1"]').click();
    await page.getByTestId("workflow-add-work").click();
    await step(page, "Review").click();
    await page.getByTestId("step-back-to").selectOption("Work 2");
    await step(page, "Work 2").click();
    await remove.click();
    const confirm = page.getByTestId("step-remove-confirm");
    await expect(confirm).toContainText('Remove the step "Work 2"?');
    await expect(confirm).toContainText('"Review" goes back to "Work" instead.');
    await page.getByTestId("step-remove-confirm-cancel").click();
    await expect(step(page, "Work 2")).toBeVisible();
    await expect(remove).toBeFocused();
    await remove.click();
    await page.getByTestId("step-remove-confirm-confirm").click();
    await expect(step(page, "Work 2")).toHaveCount(0);
    await expect(page.getByTestId("step-name")).toBeFocused();
    await expect.poll(async () => (await stored(page)).steps[1].backTo).toBe("Work");
  });
});

test.describe("the keyboard", () => {
  test("keeps focus where it was after renaming a workflow", async ({ page }) => {
    await open(page);
    const name = page.getByTestId("workflow-name");
    await name.fill("Ship it");
    await name.press("Enter");
    await expect(page.locator('[data-testid="workflow-chip"][data-workflow="Ship it"]')).toBeVisible();
    await expect(name).toBeFocused();
    await name.fill("Ship it now");
    await name.press("Tab");
    await expect(page.locator('[data-testid="workflow-chip"][data-workflow="Ship it now"]')).toBeVisible();
    await expect(page.getByTestId("workflow-duplicate")).toBeFocused();
  });

  test("moves the picked step with the arrows above it or Alt and an arrow, keeping the keyboard", async ({
    page,
  }) => {
    await open(page);
    await page.locator('[data-testid="workflow-add"][data-at="1"]').click();
    await page.getByTestId("workflow-add-work").click();
    await expect(step(page, "Work 2")).toBeFocused();
    const earlier = page.getByTestId("step-move-earlier");
    const above = (await earlier.boundingBox())!;
    const node = (await step(page, "Work 2").boundingBox())!;
    expect(above.y + above.height).toBeLessThanOrEqual(node.y);
    await earlier.focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await stored(page)).steps.map((s: { name: string }) => s.name)).toEqual([
      "Work 2",
      "Work",
      "Review",
    ]);
    await expect(earlier).toBeFocused();
    await expect(earlier).toHaveAttribute("aria-disabled", "true");
    await expect(earlier).toHaveAccessibleDescription("It is the first step already.");
    await page.keyboard.press("Enter");
    await expect(step(page, "Work 2")).toHaveAttribute("aria-pressed", "true");

    await step(page, "Work 2").focus();
    await page.keyboard.press("Alt+ArrowRight");
    await expect.poll(async () => (await stored(page)).steps.map((s: { name: string }) => s.name)).toEqual([
      "Work",
      "Work 2",
      "Review",
    ]);
    await expect(step(page, "Work 2")).toBeFocused();
    // Past Review it cannot go: that would leave Review with no work before it.
    await expect(page.getByTestId("step-move-later")).toHaveAttribute("aria-disabled", "false");
    await step(page, "Work").click();
    await expect(page.getByTestId("step-move-later")).toHaveAttribute("aria-disabled", "false");
    await step(page, "Review").click();
    await expect(page.getByTestId("step-move-earlier")).toHaveAttribute("aria-disabled", "false");
  });

  test("picks a step added from the plus menu by keyboard and gives it the keyboard", async ({ page }) => {
    await open(page);
    const plus = page.locator('[data-testid="workflow-add"][data-at="1"]');
    await plus.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const added = step(page, "Check");
    await expect(added).toBeFocused();
    await expect(added).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("step-name")).toHaveValue("Check");
  });

  test("moves between the two kinds of a step with the arrows", async ({ page }) => {
    await open(page);
    await page.locator('[data-testid="workflow-add"][data-at="1"]').click();
    await page.getByTestId("workflow-add-work").click();
    await page.getByTestId("step-kind-work").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("step-kind-review")).toBeFocused();
    await expect(page.getByTestId("step-kind-review")).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("step-kind-work")).toBeFocused();
    await expect(page.getByTestId("step-kind-work")).toHaveAttribute("aria-checked", "true");
    // Only the chosen kind is a stop on Tab.
    await expect(page.getByTestId("step-kind-review")).toHaveAttribute("tabindex", "-1");
  });

  test("opens the plus as a menu below it that the arrows walk and that closes when left", async ({
    page,
  }) => {
    await open(page);
    const plus = page.locator('[data-testid="workflow-add"][data-at="1"]');
    await expect(plus).toHaveAttribute("aria-haspopup", "menu");
    await plus.click();
    const menu = page.getByRole("menu", { name: "Add a step after Work" });
    await expect(menu).toBeVisible();
    const under = (await menu.boundingBox())!;
    const at = (await plus.boundingBox())!;
    expect(under.y).toBeGreaterThanOrEqual(at.y + at.height);
    await expect(page.getByRole("menuitem", { name: /Work step/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: /Review step/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: /Work step/ })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);

    await plus.click();
    await expect(menu).toBeVisible();
    await page.getByTestId("workflow-told-toggle").click({ position: { x: 4, y: 4 } });
    await expect(menu).toHaveCount(0);
  });

  test("names a model's checkbox by the model alone, apart from its use first button", async ({ page }) => {
    await open(page);
    await page.locator('[data-testid="step-model"][data-model="opus"]').check();
    await expect(page.getByRole("checkbox", { name: "Opus", exact: true })).toBeChecked();
    await expect(page.getByRole("button", { name: "Use Opus first" })).toBeVisible();
  });
});

test.describe("what the step's settings say", () => {
  test("say a refusal beside the control it came from, and drop it when another step is picked", async ({
    page,
  }) => {
    await open(page);
    await step(page, "Review").click();
    await page.getByTestId("step-name").fill("work");
    await page.getByTestId("step-name").press("Enter");
    const refusal = page.locator('[data-testid="step-problem"][data-where="name"]');
    await expect(refusal).toBeInViewport();
    await expect(refusal).toContainText("taken");
    await step(page, "Work").click();
    await expect(page.getByTestId("step-problem")).toHaveCount(0);
    await step(page, "Review").click();
    await expect(page.getByTestId("step-problem")).toHaveCount(0);
  });

  test("keep Any model ticked when it is clicked with no model chosen", async ({ page }) => {
    await open(page);
    const any = page.getByTestId("step-model-any");
    await any.check();
    await expect.poll(async () => (await stored(page)).steps[0].models).toEqual([]);
    await any.click();
    await expect(any).toBeChecked();
    await expect(step(page, "Work")).toContainText("Any model");
  });

  test("put the review's otherwise as one sentence, offering only earlier work steps", async ({ page }) => {
    await open(page, fourSteps);
    await step(page, "Final review").click();
    const options = await page.getByTestId("step-back-to").locator("option").allTextContents();
    expect(options).toEqual(["Plan", "Build"]);
    await expect(page.getByTestId("step-settings")).toContainText("go back to");
    await expect(page.getByTestId("step-settings")).toContainText("times, then ask me");
  });

  test("say where new sessions stand beside the switch, pointing at project choices only where there are some", async ({
    page,
  }) => {
    await installFakeCore(page, { open: [] });
    await page.goto("/");
    await expect(page.locator(AGENT)).toBeVisible();
    await page.keyboard.press(`${MOD}+,`);
    await page.getByTestId("settings-tab-workflows").click();
    await expect(page.getByTestId("workflow-default-line")).toHaveText("New sessions start with this workflow.");
    await expect(page.getByTestId("workflow-overrides")).toHaveCount(0);
  });

  test("say where new sessions stand beside the switch, without contradicting it", async ({ page }) => {
    await open(page);
    const line = page.getByTestId("workflow-default-line");
    await expect(line).toHaveText(
      "New sessions start with this workflow. A project can choose another under Project choices.",
    );
    await page.getByTestId("workflow-new").click();
    await expect(page.getByTestId("workflow-default")).toHaveAttribute("aria-checked", "false");
    await expect(line).toHaveText("New sessions start with Build and review.");
  });
});

test.describe("a workflow the file cannot use", () => {
  const careful = {
    name: "Careful",
    reason: "the step Review of Careful goes back between 1 and 10 times, not 11",
    entry: { name: "Careful" },
    at: 1,
    default: true,
    projects: [PROJECT],
  };

  test("is named with the rule it breaks, kept in the file, and removed only when asked", async ({ page }) => {
    await open(page, {
      workflows: {
        list: [
          {
            name: "Build and review",
            orchestrator: claude("fable"),
            steps: [{ kind: "work", name: "Work", models: [], parallel: 1 }],
          },
        ],
        default: null,
        overrides: {},
        unread: [careful],
      },
    });
    const notice = page.getByTestId("workflow-unread");
    await expect(notice).toContainText('"Careful" in the settings file is not used.');
    await expect(notice).toContainText("goes back between 1 and 10 times, not 11");
    await expect(notice).toContainText("One project chose it.");
    // Another change carries it through.
    await page.getByTestId("workflow-orchestrator-model").selectOption("claude-code:opus");
    await expect.poll(async () => (await file(page)).workflows.unread).toEqual([careful]);

    // Cancel gives the keyboard back to Remove, and removing it to the chips.
    await page.getByTestId("workflow-unread-remove").click();
    await page.getByTestId("workflow-unread-confirm-cancel").click();
    await expect(page.getByTestId("workflow-unread-remove")).toBeFocused();
    await page.getByTestId("workflow-unread-remove").click();
    await page.getByTestId("workflow-unread-confirm-confirm").click();
    await expect(notice).toHaveCount(0);
    await expect(page.locator('[data-testid="workflow-chip"][aria-pressed="true"]')).toBeFocused();
    await expect.poll(async () => (await file(page)).workflows.unread).toBeUndefined();
  });

  test("keeps its name taken, so no workflow is renamed to it", async ({ page }) => {
    await open(page, {
      workflows: {
        list: [
          {
            name: "Build and review",
            orchestrator: claude("fable"),
            steps: [{ kind: "work", name: "Work", models: [], parallel: 1 }],
          },
        ],
        default: null,
        overrides: {},
        unread: [careful],
      },
    });
    await page.getByTestId("workflow-name").fill("Careful");
    await page.getByTestId("workflow-name").press("Enter");
    await expect(page.getByTestId("workflow-problem")).toContainText("not used");
    await expect(page.getByTestId("workflow-name")).toHaveValue("Build and review");
  });
});

test.describe("a change the settings refuse", () => {
  test("is said, and the window shows what is stored", async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __refuseSettings?: string }).__refuseSettings = "could not write the settings file";
    });
    await page.getByTestId("workflow-orchestrator-model").selectOption("claude-code:opus");
    await expect(page.getByTestId("workflow-refused")).toContainText(
      "The change was not kept: could not write the settings file.",
    );
    await expect(page.getByTestId("workflow-orchestrator-model")).toHaveValue("claude-code:fable");
  });
});
