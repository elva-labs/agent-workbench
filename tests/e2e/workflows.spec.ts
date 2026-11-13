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
    await expect(label).toHaveText("Back to Work until approved, 3 rounds at most");
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
      "Back to Plan until approved, 2 rounds at most",
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
    await expect(page.getByTestId("step-heading")).toHaveText("Work");
    const canvas = (await page.getByTestId("workflow-canvas").boundingBox())!;
    const beside = (await panel.boundingBox())!;
    expect(beside.x).toBeGreaterThanOrEqual(canvas.x + canvas.width);
    expect(beside.y).toBeLessThan(canvas.y + canvas.height);

    await step(page, "Review").click();
    await expect(page.getByTestId("step-heading")).toHaveText("Review");
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
    await expect(page.getByTestId("workflow-loop-label")).toContainText("Back to Build");
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
    await page.getByTestId("step-agrees").click();
    await expect(page.getByTestId("step-problem")).toBeVisible();
    await expect(page.getByTestId("step-agrees")).toBeChecked();

    await page.getByTestId("step-back-to").selectOption("Work 2");
    await expect.poll(async () => (await stored(page)).steps[2].backTo).toBe("Work 2");
    await expect(page.getByTestId("workflow-loop")).toHaveAttribute("data-to", "Work 2");
    await page.getByTestId("step-limit").fill("5");
    await page.getByTestId("step-limit").press("Enter");
    await expect(page.getByTestId("workflow-loop-label")).toHaveText(
      "Back to Work 2 until approved, 5 rounds at most",
    );
    // A review goes back only to a step before it.
    const options = await page.getByTestId("step-back-to").locator("option").allTextContents();
    expect(options).toEqual(["Work", "Work 2"]);
  });

  test("reorder and remove steps, and a first step cannot be a review", async ({ page }) => {
    await open(page);
    await expect(page.getByTestId("step-kind-review")).toBeDisabled();
    await expect(page.getByTestId("step-earlier")).toBeDisabled();
    await expect(page.getByTestId("step-remove")).toBeEnabled();

    await page.locator('[data-testid="workflow-add"][data-at="1"]').click();
    await page.getByTestId("workflow-add-work").click();
    await expect(page.getByTestId("step-heading")).toHaveText("Work 2");
    await page.getByTestId("step-earlier").click();
    await expect(page.getByTestId("step-heading")).toHaveText("Work 2");
    const first = (await step(page, "Work 2").boundingBox())!;
    const second = (await step(page, "Work").boundingBox())!;
    expect(first.x).toBeLessThan(second.x);

    await page.getByTestId("step-remove").click();
    await expect(step(page, "Work 2")).toHaveCount(0);
    await expect
      .poll(async () => (await stored(page)).steps.map((s: { name: string }) => s.name))
      .toEqual(["Work", "Review"]);
    await step(page, "Review").click();
    await page.getByTestId("step-remove").click();
    await expect(step(page, "Review")).toHaveCount(0);
    await expect(page.getByTestId("step-remove")).toBeDisabled();
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
    await expect(page.getByTestId("step-kind-work")).toBeFocused();
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
