import { expect, test, type Page } from "@playwright/test";
import { BUILD_AND_REVIEW, PROJECT, installFakeCore } from "./fake";

/**
 * The workflow chip in the composer of a new conversation: it says the
 * workflow the session follows, opens the workflows to pick from before the
 * first message, and goes once one is sent. Picking one starts the unused
 * session again as the workflow's orchestrator, on the same row, with the
 * words being written and the keyboard where they were.
 */

const AGENT = "section[data-pane='agent']";

const PLAN_WORK_REVIEW = {
  ...BUILD_AND_REVIEW,
  name: "Plan, work, review",
  steps: [
    { kind: "work", name: "Plan", models: [{ agent: "claude-code", model: "opus" }], parallel: 1 },
    ...BUILD_AND_REVIEW.steps,
  ],
};
const CODEX_FLOW = { ...BUILD_AND_REVIEW, name: "Codex directs", orchestrator: { agent: "codex", model: "default" } };

type Call = { method: string; id?: string; options?: Record<string, unknown> };

function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window as unknown as { __integrated: { calls: Call[] } }).__integrated.calls);
}

const starts = async (page: Page) => (await calls(page)).filter((call) => call.method === "start");

/** A new integrated session in a project that follows no workflow, with
    the workflows given in the settings. */
async function open(page: Page, list: unknown[] = [BUILD_AND_REVIEW, PLAN_WORK_REVIEW], extra: Record<string, unknown> = {}) {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: { integrated: ["claude-code"], workflows: { list, default: null, overrides: {} } },
    ...extra,
  });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  // With two agents, New session asks which.
  if (extra.agents !== undefined) await page.getByTestId("start-agent-claude-code").click();
  await expect(page.getByTestId("model-chip")).toBeEnabled();
}

const chip = (page: Page) => page.getByTestId("workflow-chip");
const options = (page: Page) => page.getByTestId("workflow-option");

test("a new conversation offers the workflows beside the model, each saying what it does", async ({ page }) => {
  await open(page);
  await expect(chip(page)).toHaveText("No workflow");
  await expect(chip(page)).toHaveAccessibleName("Workflow: none");
  // Beside the model and the mode, in that order, on one line.
  const boxes = await Promise.all(
    ["model-chip", "mode-chip", "workflow-chip"].map(async (id) => (await page.getByTestId(id).boundingBox())!),
  );
  expect(boxes[0].x).toBeLessThan(boxes[1].x);
  expect(boxes[1].x).toBeLessThan(boxes[2].x);
  expect(Math.abs(boxes[0].y - boxes[2].y)).toBeLessThan(1);

  await chip(page).click();
  const menu = page.getByTestId("workflow-menu");
  await expect(menu).toBeVisible();
  await expect(options(page).locator(".name")).toHaveText(["No workflow", "Build and review", "Plan, work, review"]);
  await expect(options(page).locator(".about")).toHaveText([
    "Claude works alone, on the model you pick",
    "Fable directs, Sonnet works, Opus reviews",
    "Fable directs, Opus works, Sonnet works, Opus reviews",
  ]);
  await expect(options(page).first()).toHaveAttribute("aria-checked", "true");
  await expect(menu).toContainText("Chosen before the first message, then kept.");
  // With room to the chip's left, it opens over the composer from the
  // chip's right edge.
  const box = (await menu.boundingBox())!;
  const chipBox = (await chip(page).boundingBox())!;
  const composer = (await page.getByTestId("composer").boundingBox())!;
  expect(Math.abs(box.x + box.width - (chipBox.x + chipBox.width))).toBeLessThan(1);
  expect(box.y + box.height).toBeLessThan(chipBox.y);
  expect(box.x).toBeGreaterThanOrEqual(composer.x - 0.5);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(chip(page)).toBeFocused();
});

// A fresh install has two workflows, neither turned on: Build and review,
// and Direct, which hands each piece to a session of its own on any model.
test("offers the shipped workflows on a fresh install, Direct among them", async ({ page }) => {
  await installFakeCore(page, { open: [PROJECT], settings: { integrated: ["claude-code"] } });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.getByTestId("model-chip")).toBeEnabled();
  await expect(chip(page)).toHaveText("No workflow");
  await chip(page).click();
  await expect(options(page).locator(".name")).toHaveText(["No workflow", "Build and review", "Direct"]);
  await expect(options(page).locator(".about")).toHaveText([
    "Claude works alone, on the model you pick",
    "Fable directs, Sonnet works, Opus reviews",
    "Fable directs, any model works",
  ]);

  // Picked, the session starts again as Direct's orchestrator, told it.
  await options(page).filter({ has: page.locator(".name", { hasText: /^Direct$/ }) }).click();
  await expect(chip(page)).toHaveText("Direct");
  await expect.poll(async () => (await starts(page)).length).toBe(2);
  const told = (await starts(page)).at(-1)!.options as { instructions?: string; startOnly?: boolean };
  expect(told.instructions).toContain('You are the orchestrator of the Chord workflow "Direct".');
  expect(told.instructions).toContain('For the step "Work", split the task into pieces and start a session for each, on any agent and model. Run at most 8 "Work" sessions at once');
  expect(told.startOnly).toBe(true);
});

test("picking a workflow makes the session its orchestrator, as New session under it would, keeping the row, the words and the keyboard", async ({
  page,
  browser,
}) => {
  // What New session starts in a project that follows the workflow, in a
  // window of its own.
  const elsewhere = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const direct = await elsewhere.newPage();
  await installFakeCore(direct, {
    open: [PROJECT],
    settings: { integrated: ["claude-code"], workflows: { list: [BUILD_AND_REVIEW], default: "Build and review", overrides: {} } },
  });
  await direct.goto("/");
  await direct.getByTestId("start-agent").click();
  await expect(direct.getByTestId("model-chip")).toBeVisible();
  const [made] = await starts(direct);
  await elsewhere.close();

  await open(page);
  const [first] = await starts(page);
  expect(first.options!.instructions).toBeUndefined();
  const input = page.getByTestId("composer-input");
  await input.fill("Make the sessions pane fill quickly after a restart.");
  await chip(page).click();
  await options(page).filter({ hasText: "Build and review" }).click();

  // The run it leaves is stopped, and a new one started under the
  // workflow: told what New session under it is told, with the row's own
  // token.
  await expect.poll(async () => (await starts(page)).length).toBe(2);
  const [, second] = await starts(page);
  expect((await calls(page)).some((call) => call.method === "stop" && call.id === "int-1")).toBe(true);
  const { token: madeToken, ...madeRest } = made.options!;
  const { token, ...rest } = second.options!;
  expect(rest).toEqual(madeRest);
  expect(madeToken).toEqual(expect.any(String));
  expect(token).toBe(first.options!.token);
  expect(rest).toMatchObject({ model: "fable", startOnly: true });

  // The same row, the words and the keyboard where they were.
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await expect(input).toHaveValue("Make the sessions pane fill quickly after a restart.");
  await expect(input).toBeFocused();
  await expect(chip(page)).toHaveText("Build and review");
  await expect(chip(page)).toHaveAccessibleName("Workflow: Build and review");
  await expect(page.getByTestId("thread-intro")).toHaveText(
    "A new Claude Code session in demo, following Build and review. It directs; Sonnet works and Opus reviews.",
  );
  // The workflow sets the model: shown, held, and saying why.
  const model = page.getByTestId("model-chip");
  await expect(model).toHaveText("Fable");
  await expect(model).toHaveAttribute("aria-disabled", "true");
  await expect(model).toHaveAttribute("title", "Set by Build and review");
  await expect(model).toHaveAccessibleName("Model Fable, set by Build and review");
  // The status bar names it as the composer does, and holds it too.
  const readout = page.getByTestId("model-readout");
  await expect(readout).toHaveText("Fable");
  await expect(readout).toHaveAttribute("title", "Set by Build and review");
  // A press on it opens nothing.
  await model.dispatchEvent("click");
  await expect(page.getByTestId("model-menu")).toHaveCount(0);
  // The composer says the workflow; the header's chip waits for the first
  // message.
  await expect(page.getByTestId("run-chip")).toHaveCount(0);
  await expect(page.getByTestId("workflow-tag")).toHaveCount(0);

  // Sent, the choice is kept: the chip leaves the composer and the
  // header's chip names the workflow.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await expect(chip(page)).toHaveCount(0);
  await expect(page.getByTestId("run-words")).toHaveText("Build and review");
  await expect(model).toHaveAttribute("aria-disabled", "true");
  const sent = (await calls(page)).filter((call) => call.method === "send");
  expect(sent.map((call) => call.id)).toEqual(["int-2"]);
});

test("going back to no workflow starts the agent alone, on its own default model", async ({ page }) => {
  await open(page);
  await chip(page).click();
  await options(page).filter({ hasText: "Build and review" }).click();
  await expect(page.getByTestId("model-chip")).toHaveAttribute("aria-disabled", "true");
  await chip(page).click();
  await expect(options(page).nth(1)).toHaveAttribute("aria-checked", "true");
  await options(page).filter({ hasText: "No workflow" }).click();
  await expect.poll(async () => (await starts(page)).length).toBe(3);
  const last = (await starts(page)).at(-1)!.options!;
  expect(last.instructions).toBeUndefined();
  expect(last.startOnly).toBeUndefined();
  expect(last.model).toBeUndefined();
  await expect(page.getByTestId("model-chip")).toHaveText("Default · Sonnet");
  await expect(page.getByTestId("model-chip")).toBeEnabled();
  await expect(page.getByTestId("thread-intro")).toContainText("with your login, settings, hooks and tools");
});

test("a message sent while the session starts again waits for the new run", async ({ page }) => {
  await open(page);
  // The core takes its time over the next start.
  await page.evaluate(() => {
    const core = (window as unknown as { __WORKBENCH_CORE__: { integratedStart: (options: unknown) => Promise<unknown> } })
      .__WORKBENCH_CORE__;
    const plain = core.integratedStart;
    const w = window as unknown as { __letStart?: () => void };
    core.integratedStart = (options) =>
      new Promise((resolve) => {
        w.__letStart = () => resolve(plain(options));
      });
  });
  await chip(page).click();
  await options(page).filter({ hasText: "Build and review" }).click();
  const input = page.getByTestId("composer-input");
  await input.fill("Fix the scan");
  // Nothing dims while it starts again: Send stays as it was.
  await expect(page.getByTestId("send")).toBeEnabled();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("composer-held")).toHaveText("Sends once Claude is ready.");
  expect((await calls(page)).filter((call) => call.method === "send")).toEqual([]);
  await page.evaluate(() => (window as unknown as { __letStart: () => void }).__letStart());
  await expect(page.getByTestId("user-message")).toHaveCount(1);
  await expect(input).toHaveValue("");
  const sent = (await calls(page)).filter((call) => call.method === "send");
  expect(sent.map((call) => call.id)).toEqual(["int-2"]);
  await expect(chip(page)).toHaveCount(0);
});

test("is picked by keyboard alone", async ({ page }) => {
  await open(page);
  const input = page.getByTestId("composer-input");
  await expect(input).toBeFocused();
  for (const id of ["attach", "model-chip", "mode-chip", "workflow-chip"]) {
    await page.keyboard.press("Tab");
    await expect(page.getByTestId(id)).toBeFocused();
  }
  await page.keyboard.press("Enter");
  // The keyboard on the workflow followed; the arrows walk, Enter picks.
  await expect(options(page).first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(options(page).nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workflow-menu")).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(chip(page)).toHaveText("Build and review");
  // The held model is a stop that says why and opens nothing.
  await page.getByTestId("attach").focus();
  await page.keyboard.press("Tab");
  const model = page.getByTestId("model-chip");
  await expect(model).toBeFocused();
  await expect(model).toHaveAccessibleName("Model Fable, set by Build and review");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("model-menu")).toHaveCount(0);
  await expect(model).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("mode-chip")).toBeFocused();
});

test("opens its menu inside the conversation where the chip has wrapped to the bar's second line", async ({ page }) => {
  // The window's three panes leave the conversation narrow, and before a
  // workflow is picked the model chip is wide enough to push the workflow
  // chip onto a line of its own, at the left.
  await page.setViewportSize({ width: 1000, height: 800 });
  await open(page);
  const chipBox = (await chip(page).boundingBox())!;
  const modelBox = (await page.getByTestId("model-chip").boundingBox())!;
  expect(chipBox.y).toBeGreaterThan(modelBox.y + modelBox.height);
  await chip(page).click();
  const box = (await page.getByTestId("workflow-menu").boundingBox())!;
  const conversation = (await page.getByTestId("conversation").boundingBox())!;
  const composer = (await page.getByTestId("composer").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(conversation.x);
  expect(box.x + box.width).toBeLessThanOrEqual(conversation.x + conversation.width);
  expect(box.x).toBeGreaterThanOrEqual(composer.x - 0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(composer.x + composer.width + 0.5);
  expect(box.y + box.height).toBeLessThan(chipBox.y);
  // Every workflow's name is there to read.
  for (const name of await options(page).locator(".name").all()) {
    const at = (await name.boundingBox())!;
    expect(at.x).toBeGreaterThanOrEqual(conversation.x);
  }
});

test("lists a workflow directed by an agent that is not here, saying why, and does not take it", async ({ page }) => {
  await open(page, [BUILD_AND_REVIEW, CODEX_FLOW]);
  await chip(page).click();
  const codex = options(page).filter({ hasText: "Codex directs" });
  await expect(codex).toHaveAttribute("aria-disabled", "true");
  await expect(codex.locator(".about")).toHaveText("Directed by Codex, which is not installed here");
  // Walked to like the others, and Enter on it does nothing.
  await page.keyboard.press("End");
  await expect(codex).toBeFocused();
  await page.keyboard.press("Enter");
  await codex.dispatchEvent("click");
  await expect(page.getByTestId("workflow-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(chip(page)).toHaveText("No workflow");
  expect(await starts(page)).toHaveLength(1);
});

test("starts the orchestrator on another agent that runs as a conversation", async ({ page }) => {
  await open(page, [BUILD_AND_REVIEW, CODEX_FLOW], { agents: ["claude-code", "codex"], integrable: ["claude-code", "codex"] });
  await chip(page).click();
  await options(page).filter({ hasText: "Codex directs" }).click();
  await expect.poll(async () => (await starts(page)).length).toBe(2);
  expect((await starts(page))[1].options).toMatchObject({ agent: "codex", startOnly: true });
  await expect(page.getByTestId("thread-intro")).toContainText("A new Codex session in demo, following Codex directs.");
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", /Tell Codex what to do/);
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  // No workflow goes back to the agent the session was started on.
  await chip(page).click();
  await expect(options(page).first().locator(".about")).toHaveText("Claude works alone, on the model you pick");
  await options(page).first().click();
  await expect.poll(async () => (await starts(page)).length).toBe(3);
  expect((await starts(page))[2].options).toMatchObject({ agent: "claude-code" });
  await expect(page.getByTestId("composer-input")).toHaveAttribute("placeholder", /Tell Claude what to do/);
});

test("shows no chip where there is no workflow to choose", async ({ page }) => {
  await open(page, []);
  await expect(page.getByTestId("mode-chip")).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
});

test("shows no chip for a session in a terminal", async ({ page }) => {
  await installFakeCore(page, {
    open: [PROJECT],
    settings: { workflows: { list: [BUILD_AND_REVIEW], default: null, overrides: {} } },
  });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(page.locator(`${AGENT} .xterm`)).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
});

test("leaves the composer once the session has ended unspoken, and the header names the workflow again", async ({ page }) => {
  await open(page, [BUILD_AND_REVIEW]);
  await chip(page).click();
  await options(page).filter({ hasText: "Build and review" }).click();
  await expect.poll(async () => (await starts(page)).length).toBe(2);
  await page.evaluate(() => (window as unknown as { __integrated: { end: (id: string, clean: boolean) => void } }).__integrated.end("int-2", true));
  await expect(page.getByTestId("resume-session")).toBeVisible();
  await expect(chip(page)).toHaveCount(0);
  await expect(page.getByTestId("run-words")).toHaveText("Build and review");
});
