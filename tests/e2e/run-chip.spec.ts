import { expect, test, type Page } from "@playwright/test";
import { PROJECT, installFakeCore } from "./fake";

/**
 * Where a workflow's run stands, on the orchestrator's header, on the rail
 * and on its started sessions' own headers, driven through a whole run by
 * calls pushed at the conductor and hook events for what each session is
 * doing.
 */

const AGENT = "section[data-pane='agent']";

/** Plan, then Work, then a Review that sends the work back three times at
    most. */
const PLAN_WORK_REVIEW = {
  name: "Plan, work, review",
  orchestrator: { agent: "claude-code", model: "fable" },
  steps: [
    { kind: "work", name: "Plan", models: [{ agent: "claude-code", model: "opus" }], parallel: 1 },
    { kind: "work", name: "Work", models: [{ agent: "claude-code", model: "sonnet" }], parallel: 2 },
    {
      kind: "review",
      name: "Review",
      models: [{ agent: "claude-code", model: "opus" }],
      reviewerApproves: true,
      orchestratorAgrees: true,
      backTo: "Work",
      limit: 3,
    },
  ],
};

const settingsWith = (workflow: typeof PLAN_WORK_REVIEW) => ({
  workflows: { list: [workflow], default: workflow.name, overrides: {} },
});

let calls = 0;

/** A call from the orchestrator, answered before this returns. */
async function call(page: Page, tool: string, args: Record<string, unknown>) {
  const id = `c-${++calls}`;
  await page.evaluate(
    ({ project, id, tool, args }) =>
      (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
        id,
        tool,
        arguments: args,
        cwd: project,
        session: "session-1",
      }),
    { project: PROJECT, id, tool, args },
  );
  const ask = page.getByTestId("conduct-allow");
  await expect
    .poll(async () => {
      if (await ask.isVisible()) await ask.click();
      const answers =
        (await page.evaluate(() => (window as unknown as { __conductAnswers?: { id: string }[] }).__conductAnswers)) ?? [];
      return answers.some((answer) => answer.id === id);
    })
    .toBe(true);
}

/** What a session's hooks say it is doing: prompt is at work, stop at rest. */
async function event(page: Page, session: string, kind: "prompt" | "stop" | "permission") {
  await page.evaluate(
    ({ session, kind }) =>
      (window as unknown as { __sessionEvent: (event: { sessionId: string; kind: string }) => void }).__sessionEvent({
        sessionId: session,
        kind,
      }),
    { session, kind },
  );
}

const chip = (page: Page) => page.getByTestId("run-chip");
const words = (page: Page) => page.getByTestId("run-words");
const pips = (page: Page) =>
  page.getByTestId("run-pips").evaluate((node) => [...node.children].map((pip) => pip.classList[0]));

async function begin(page: Page, workflow = PLAN_WORK_REVIEW) {
  calls = 0;
  await installFakeCore(page, { settings: settingsWith(workflow) });
  await page.goto("/");
  await page.getByTestId("start-agent").click();
  await expect(chip(page)).toBeVisible();
}

test.describe("the run's chip", () => {
  test("follows a run from its plan to done", async ({ page }) => {
    await begin(page);
    // Nothing started: the workflow's name, every step to come.
    await expect(words(page)).toHaveText("Plan, work, review");
    expect(await pips(page)).toEqual(["todo", "todo", "todo"]);
    // Right after the title, in the place the quiet tag had.
    const title = (await page.locator(`${AGENT} header .title`).boundingBox())!;
    const box = (await chip(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(title.x + title.width);
    expect(box.x).toBeLessThan(title.x + title.width + 16);

    await call(page, "start", { project: PROJECT, prompt: "Plan it", step: "Plan", name: "Plan the startup fix" });
    await event(page, "session-2", "prompt");
    await expect(words(page)).toHaveText("Plan");
    expect(await pips(page)).toEqual(["live", "todo", "todo"]);

    await event(page, "session-2", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-3", "prompt");
    await expect(words(page)).toHaveText("Work");
    expect(await pips(page)).toEqual(["done", "live", "todo"]);

    await event(page, "session-3", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Review it", step: "Review", work: "session-3", name: "Review the cache fix" });
    await event(page, "session-4", "prompt");
    await expect(words(page)).toHaveText("Review, round 1 of 4");
    expect(await pips(page)).toEqual(["done", "done", "live"]);
    await expect(chip(page)).toHaveAttribute("aria-label", /Review, round 1 of 4\. Plan done, Work done, Review now\./);

    // Sent back: the work's second round, and the review to come again.
    await event(page, "session-4", "stop");
    await call(page, "send", { session: "session-3", text: "Make it smaller" });
    await event(page, "session-3", "prompt");
    await expect(words(page)).toHaveText("Work, round 2 of 4");
    expect(await pips(page)).toEqual(["done", "live", "todo"]);
    // The rail says the round short.
    const workRow = page.getByTestId("started-session").filter({ hasText: "Fix the cache" });
    await expect(workRow.getByTestId("started-role")).toHaveText("Work, 2 of 4");

    await event(page, "session-3", "stop");
    await call(page, "send", { session: "session-4", text: "Look again" });
    await event(page, "session-4", "prompt");
    await expect(words(page)).toHaveText("Review, round 2 of 4");
    const reviewRow = page.getByTestId("started-session").filter({ hasText: "Review the cache fix" });
    await expect(reviewRow.getByTestId("started-role")).toHaveText("Review, 2 of 4");

    // Passed, and the orchestrator at rest: done.
    await event(page, "session-4", "stop");
    await event(page, "session-1", "stop");
    await expect(words(page)).toHaveText("Done");
    expect(await pips(page)).toEqual(["done", "done", "done"]);
  });

  test("counts the pieces in each step, with the rounds in its popover", async ({ page }) => {
    await begin(page);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Review it", step: "Review", work: "session-2", name: "Review the cache fix" });
    await event(page, "session-3", "prompt");
    await call(page, "start", { project: PROJECT, prompt: "Filter", step: "Work", name: "Palette filter" });
    await event(page, "session-4", "prompt");
    await expect(words(page)).toHaveText("1 in Work, 1 in Review");
    expect(await pips(page)).toEqual(["done", "live", "live"]);

    await chip(page).click();
    const popover = page.getByTestId("run-popover");
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId("run-step")).toHaveText([
      /Plan\s*none/,
      /Work\s*done · Fix the cache\s*working · Palette filter/,
      /Review\s*round 1 of 4, working · Review the cache fix/,
    ]);
    // Under the chip and inside the pane.
    const box = (await chip(page).boundingBox())!;
    const pop = (await popover.boundingBox())!;
    const pane = (await page.locator(AGENT).boundingBox())!;
    expect(pop.y).toBeGreaterThanOrEqual(box.y + box.height);
    expect(pop.x + pop.width).toBeLessThanOrEqual(pane.x + pane.width);
    // The rules fold out at its foot.
    await expect(page.getByTestId("run-rules")).toHaveCount(0);
    await page.getByTestId("run-rules-toggle").click();
    await expect(page.getByTestId("run-rules")).toContainText('For the step "Work"');
    // A session's name opens it.
    await popover.getByTestId("run-open").filter({ hasText: "Palette filter" }).click();
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId("workflow-tag-role")).toHaveText("Work");
    await expect(page.getByTestId("workflow-tag-flow")).toHaveText("Plan, work, review·");
  });

  test("turns to the accent while another round waits on the user", async ({ page }) => {
    const once = structuredClone(PLAN_WORK_REVIEW);
    (once.steps[2] as { limit: number }).limit = 1;
    await begin(page, once);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Review it", step: "Review", work: "session-2" });
    await call(page, "start", { project: PROJECT, prompt: "Review again", step: "Review", work: "session-2" });
    const colour = () => chip(page).evaluate((node) => getComputedStyle(node).color);
    const quiet = await colour();
    // The third round is asked about, and the chip says so while it waits.
    await page.evaluate(
      ({ project }) =>
        (window as unknown as { __conductRequest: (call: unknown) => void }).__conductRequest({
          id: "c-past",
          tool: "start",
          arguments: { project, prompt: "Once more", step: "Review", work: "session-2" },
          cwd: project,
          session: "session-1",
        }),
      { project: PROJECT },
    );
    await expect(page.getByTestId("conduct-round")).toBeVisible();
    await expect(words(page)).toHaveText("Round 2 of 2 done, asks you");
    expect(await pips(page)).toEqual(["done", "done", "live"]);
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent"));
    expect(await colour()).not.toBe(quiet);
    expect(accent.trim().length).toBeGreaterThan(0);
    await page.getByTestId("conduct-no").click();
    await expect(words(page)).not.toHaveText(/asks you/);
  });

  test("opens from the keyboard, names its state in words, and gives the keyboard back on Escape", async ({ page }) => {
    await begin(page);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "prompt");
    await expect(chip(page)).toHaveAttribute(
      "aria-label",
      "Plan, work, review: Work. Plan done, Work now, Review to come. Show where the run stands",
    );
    await expect(chip(page)).not.toHaveAttribute("aria-controls");
    // A stop of its own on Tab, as every control is.
    await expect(chip(page)).toHaveAttribute("tabindex", "0");
    await chip(page).focus();
    await page.keyboard.press("Enter");
    const popover = page.getByTestId("run-popover");
    await expect(popover).toBeVisible();
    await expect(chip(page)).toHaveAttribute("aria-expanded", "true");
    expect(await popover.getAttribute("id")).toBe(await chip(page).getAttribute("aria-controls"));
    // Tab goes on into the popover, and it stays open.
    await page.keyboard.press("Tab");
    await expect(popover.getByTestId("run-open").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
    // Shown while the pointer rests on it, and gone when it leaves.
    await chip(page).hover();
    await expect(popover).toBeVisible();
    const pane = (await page.locator(AGENT).boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height - 20);
    await expect(popover).toHaveCount(0);
  });

  test("keeps its pips as the header narrows, its words going before the title is cut", async ({ page }) => {
    await begin(page);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "prompt");
    await call(page, "start", { project: PROJECT, prompt: "Filter", step: "Work", name: "Palette filter" });
    await event(page, "session-3", "prompt");
    await expect(words(page)).toHaveText("2 in Work");
    const state = () =>
      page.evaluate((AGENT) => {
        const header = document.querySelector(`${AGENT} header`)!;
        const title = header.querySelector<HTMLElement>(".title")!;
        const words = header.querySelector<HTMLElement>("[data-testid='run-words']")!;
        const pips = header.querySelector<HTMLElement>("[data-testid='run-pips']")!;
        const meta = header.querySelector<HTMLElement>(".meta");
        const drawn = (el: HTMLElement | null) =>
          el !== null && getComputedStyle(el).visibility !== "hidden" && el.getBoundingClientRect().width > 0.5;
        const head = header.closest("section")!.getBoundingClientRect();
        const pipsBox = pips.getBoundingClientRect();
        return {
          titleCut: title.scrollWidth > title.clientWidth + 0.5,
          wordsDrawn: drawn(words),
          wordsCut: words.scrollWidth > words.clientWidth + 0.5,
          metaDrawn: drawn(meta),
          pipsInside: pipsBox.width > 20 && pipsBox.right <= head.right - 8,
        };
      }, AGENT);
    const wide = await state();
    expect(wide).toMatchObject({ titleCut: false, wordsDrawn: true, wordsCut: false, pipsInside: true });
    // The pane narrowed under it.
    let sawWordsGone = false;
    for (const width of [380, 300, 240, 200, 150]) {
      await page.locator(AGENT).evaluate((pane, width) => {
        (pane as HTMLElement).style.flex = `0 0 ${width}px`;
        (pane as HTMLElement).style.width = `${width}px`;
        (pane as HTMLElement).style.minWidth = `${width}px`;
      }, width);
      await expect.poll(async () => (await page.locator(AGENT).boundingBox())!.width).toBeLessThan(width + 1);
      const at = await state();
      expect(at.pipsInside, `at ${width}`).toBe(true);
      if (at.wordsCut || !at.wordsDrawn) expect(at.metaDrawn, `at ${width}`).toBe(false);
      if (at.titleCut) expect(at.wordsDrawn, `at ${width}`).toBe(false);
      if (!at.wordsDrawn) sawWordsGone = true;
    }
    expect(sawWordsGone).toBe(true);
  });
});

test.describe("a started session's place", () => {
  test("says its round of the most in its own tag", async ({ page }) => {
    await begin(page);
    await call(page, "start", { project: PROJECT, prompt: "Fix it", step: "Work", name: "Fix the cache" });
    await event(page, "session-2", "stop");
    await call(page, "start", { project: PROJECT, prompt: "Review it", step: "Review", work: "session-2", name: "Review the cache fix" });
    await page.getByTestId("started-session").filter({ hasText: "Review the cache fix" }).click();
    await expect(page.getByTestId("workflow-tag-role")).toHaveText("Review, round 1 of 4");
  });
});
